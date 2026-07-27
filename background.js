importScripts('shared/crypto.js', 'shared/api.js', 'shared/storage.js', 'shared/bus.js', 'shared/codeutil.js');
// 插件安装或更新时触发
chrome.runtime.onInstalled.addListener(function() {
  // 初始化默认设置
  SharedStorage.getSync(['serverUrl', 'secret']).then((items) => {
    if (!items.serverUrl) {
      SharedStorage.setSync({ serverUrl: '' });
    }
    if (!items.secret) {
      SharedStorage.setSync({ secret: '' });
    }
  });
  // 创建右键菜单
  chrome.contextMenus.create({
    id: 'sendSelectedTextAsSms',
    title: '发送选中文本为短信',
    contexts: ['selection']
  });
  // 启动轮询
  initSmsPolling();
  // 配置侧边栏（如支持）
  try { ensureSidePanelEnabled(); } catch (_) {}
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'sendSelectedTextAsSms') {
    // 在用户手势回调中，先直接打开侧边栏，避免手势丢失
    if (isSidePanelSupported()) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => {
        logError(`[SidePanel] 右键打开失败: ${e && e.message ? e.message : String(e)}`);
      });
    }
    // 异步保存选中文本（不阻塞侧边栏打开）
    SharedStorage.setLocal({ selectedText: info.selectionText });
  }
});

// 点击扩展图标时打开侧边栏（直接调用，避免异步破坏用户手势）
chrome.action.onClicked.addListener((tab) => {
  if (isSidePanelSupported()) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => {
      logError(`[SidePanel] 图标打开失败: ${e && e.message ? e.message : String(e)}`);
    });
  }
});
  // 浏览器启动时确保轮询与侧边栏配置
  chrome.runtime.onStartup.addListener(() => {
    initSmsPolling();
    try { ensureSidePanelEnabled(); } catch (_) {}
  });

  // 旧的图标点击监听器已移除，改为在用户手势中直接打开侧栏
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    try {
      // 在通知点击的用户手势上下文中直接打开侧栏
      if (isSidePanelSupported()) {
        await chrome.sidePanel.open({});
      }
    } catch (e) {
      logError(`[SidePanel] 通知点击打开失败: ${e && e.message ? e.message : String(e)}`);
    }
  });
  // --------------------------- 轮询与数据处理模块 ---------------------------
  const POLL_INTERVAL_MS = 5000; // 5秒轮询
  const MAX_SMS_LIST_SIZE = 20;  // 本地保存最多20条
  const DEFAULT_SMS_TYPE = 1;    // 默认轮询接收短信

  let pollIntervalId = null;
  let retryTimerId = null;
  let consecutiveErrors = 0;
  let currentRetryDelay = POLL_INTERVAL_MS; // 初始与正常轮询间隔一致

  function initSmsPolling() {
    // 避免重复启动
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
    }
    // 立即执行一次，随后每隔 POLL_INTERVAL_MS 执行
    pollLatestSms();
    pollIntervalId = setInterval(pollLatestSms, POLL_INTERVAL_MS);
  }

  async function pollLatestSms() {
    try {
      // 拉取配置
      const cfg = await SharedStorage.getSync(['serverUrl', 'secret']);

      if (!cfg.serverUrl || !cfg.secret) {
        logError('[Polling] serverUrl/secret 未配置，跳过本轮');
        return; // 未配置则直接返回，不启动重试
      }

      const resp = await SharedApi.signedPost(
        cfg.serverUrl,
        '/sms/query',
        cfg.secret,
        { type: DEFAULT_SMS_TYPE, page_num: 1, page_size: 20 }
      );

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      if (data.code !== 200 && data.code !== 0) {
        throw new Error(`API code: ${data.code}, msg: ${data.msg || '未知错误'}`);
      }

      const list = Array.isArray(data.data) ? data.data : [];
      const updated = await mergeAndStoreSmsList(list);

      // 成功后重置重试参数
      consecutiveErrors = 0;
      currentRetryDelay = POLL_INTERVAL_MS;
      if (retryTimerId) {
        clearTimeout(retryTimerId);
        retryTimerId = null;
      }

      // 仅在有更新时通知界面刷新
      if (updated) {
        broadcastSmsUpdate();
      }
    } catch (err) {
      // 记录错误并安排重试
      logError(`[Polling] 拉取失败: ${err && err.message ? err.message : String(err)}`);
      consecutiveErrors += 1;
      const nextDelay = Math.min(currentRetryDelay * 2, 30000); // 最高30秒
      currentRetryDelay = nextDelay;

      if (!retryTimerId) {
        retryTimerId = setTimeout(() => {
          retryTimerId = null;
          pollLatestSms();
        }, currentRetryDelay);
      }
    }
  }

  async function mergeAndStoreSmsList(newList) {
    // 读取现有列表
    const local = await SharedStorage.getLocal(['polledSmsList']);
    const existing = Array.isArray(local.polledSmsList) ? local.polledSmsList : [];

    // 先记录现有键集合，用于检测新增短信（不考虑顺序变化）
    const existingKeySet = new Set(existing.map(item => getSmsKey(item)));

    // 使用 Map 进行严格去重，优先使用服务端 id；否则用复合键
    const map = new Map();
    const putItem = (sms) => {
      const key = getSmsKey(sms);
      if (!map.has(key)) {
        map.set(key, normalizeSmsItem(sms));
      }
    };

    existing.forEach(putItem);
    newList.forEach(putItem);

    // 统计新增的键数量并收集新增项
    let addedCount = 0;
    const newItems = [];
    for (const sms of newList) {
      const key = getSmsKey(sms);
      if (!existingKeySet.has(key)) {
        addedCount++;
        newItems.push(sms);
      }
    }

    // 排序（按时间戳降序）并进行容量管理
    let merged = Array.from(map.values());
    merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (merged.length > MAX_SMS_LIST_SIZE) {
      merged = merged.slice(0, MAX_SMS_LIST_SIZE);
    }

    // 仅在有新增短信时触发通知与写入存储
    if (addedCount > 0) {
      // 读取自动填充设置
      const settings = await SharedStorage.getSync(['autoFillCode', 'customCodePattern']);
      const autoFillEnabled = settings.autoFillCode !== false; // 默认开启
      const customPattern = settings.customCodePattern || '';

      // 提取验证码并触发通知（逐条）
      try {
        await Promise.all(newItems.map(async (item) => {
          const code = SharedCodeUtil.extractVerificationCode(item.content, customPattern);
          if (code) {
            item.extractedCode = code;
            if (autoFillEnabled) {
              tryAutoFillCode(code, item);
            }
          }
          await notifyNewSms(item, code);
        }));
      } catch (e) {
        logError(`[Notify] 通知发送失败: ${e && e.message ? e.message : String(e)}`);
      }

      // 写入本地存储
      await SharedStorage.setLocal({ polledSmsList: merged });
    }

    return addedCount > 0;
  }

  function getSmsKey(sms) {
    // 使用 number + 时间戳 + content 生成唯一键，时间戳兼容 date/time/timestamp
    const numberVal = sms && sms.number != null ? String(sms.number) : '';
    const tsRaw = (sms && (sms.timestamp ?? sms.date ?? sms.time)) ?? 0;
    const tsVal = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw) || 0;
    const contentVal = sms && sms.content != null ? String(sms.content) : '';
    return `${numberVal}|${tsVal}|${contentVal}`;
  }

  function normalizeSmsItem(sms) {
    const timeVal = sms && (sms.date || sms.time || 0);
    const timestamp = typeof timeVal === 'number' ? timeVal : Number(timeVal) || 0;
    return {
      ...sms,
      timestamp
    };
  }

  function broadcastSmsUpdate() {
    try {
      SharedBus.send(SharedBus.Types.SMS_LIST_UPDATED);
    } catch (e) {
      // 在某些上下文下可能没有监听者，这里仅记录
      logError(`[Broadcast] 通知失败: ${e && e.message ? e.message : String(e)}`);
    }
  }

  // --------------------------- 侧边栏辅助函数 ---------------------------
  function isSidePanelSupported() {
    try {
      return !!(chrome && chrome.sidePanel && typeof chrome.sidePanel.open === 'function');
    } catch (_) {
      return false;
    }
  }

  async function ensureSidePanelEnabled(path = 'sidepanel.html') {
    if (!isSidePanelSupported()) return false;
    try {
      if (typeof chrome.sidePanel.setOptions === 'function') {
        await chrome.sidePanel.setOptions({ path, enabled: true });
      }
      if (typeof chrome.sidePanel.setPanelBehavior === 'function') {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      }
      return true;
    } catch (e) {
      logError(`[SidePanel] 配置失败: ${e && e.message ? e.message : String(e)}`);
      return false;
    }
  }

  async function openSidePanelForTab(tab) {
    try {
      await ensureSidePanelEnabled();
      const openArgs = tab && tab.windowId ? { windowId: tab.windowId } : {};
      await chrome.sidePanel.open(openArgs);
      return true;
    } catch (e) {
      logError(`[SidePanel] 打开失败: ${e && e.message ? e.message : String(e)}`);
      return false;
    }
  }

  async function logError(message) {
    console.error(message);
    try {
      const now = new Date().toISOString();
      const { pollErrorLogs } = await SharedStorage.getLocal(['pollErrorLogs']);
      const logs = Array.isArray(pollErrorLogs) ? pollErrorLogs : [];
      logs.push({ time: now, message });
      // 保持最多50条错误日志
      const trimmed = logs.length > 50 ? logs.slice(logs.length - 50) : logs;
      await SharedStorage.setLocal({ pollErrorLogs: trimmed });
    } catch (_) {
      // 忽略日志写入错误
    }
  }

  // --------------------------- 签名模块（使用 SharedCrypto） ---------------------------
  // 本地签名逻辑已移除，统一使用 SharedCrypto.generateSign

  function signatureOfList(list) {
    try {
      return (Array.isArray(list) ? list : [])
        .map(item => `${getSmsKey(item)}@${item.timestamp ?? 0}`)
        .join('#');
    } catch (e) {
      return '';
    }
  }

  // --------------------------- 通知与复制模块 ---------------------------
  const NOTIF_MAP_KEY = 'notifSmsMap';

  async function notifyNewSms(sms, code) {
    const contact = sms.name || sms.contact || '新短信';
    const number = sms.number || sms.from || sms.to || '';
    const title = code
      ? `${contact}${number ? ' (' + number + ')' : ''} — 验证码: ${code}`
      : (number ? `${contact} (${number})` : contact);
    const message = sms.content || '';
    const notificationId = `sms-notif-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    // 保存待复制的内容
    await storeNotificationPayload(notificationId, message, code);

    // 通知按钮
    const buttons = code
      ? [
          { title: '复制验证码' },
          { title: '复制短信' }
        ]
      : [
          { title: '复制短信' }
        ];

    // 创建通知
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('images/icon48.png'),
      title,
      message,
      contextMessage: code ? '已尝试自动填入验证码' : '来源: SmsForwarder',
      requireInteraction: true,
      isClickable: true,
      priority: 2,
      buttons
    }, (createdId) => {
      if (chrome.runtime.lastError) {
        logError(`[Notify] 创建失败: ${chrome.runtime.lastError.message}`);
      }
    });
  }

  chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    const payload = await readNotificationPayload(notificationId);
    // 如果有验证码，buttonIndex 0 = 复制验证码，1 = 复制短信；否则 0 = 复制短信
    if (payload && payload.code && buttonIndex === 0) {
      await copyToClipboardViaInjection(payload.code);
    } else {
      const text = payload ? payload.text : '';
      if (text) await copyToClipboardViaInjection(text);
    }
    // 复制后清理并关闭通知
    try {
      await removeNotificationPayload(notificationId);
      chrome.notifications.clear(notificationId);
    } catch (e) {
      // 忽略清理错误
    }
  });

  chrome.notifications.onClosed.addListener(async (notificationId, byUser) => {
    // 通知关闭后清理映射
    try {
      await removeNotificationPayload(notificationId);
    } catch (_) {}
  });

  async function storeNotificationPayload(id, text, code) {
    try {
      const { [NOTIF_MAP_KEY]: notifSmsMap } = await SharedStorage.getLocal([NOTIF_MAP_KEY]);
      const map = notifSmsMap && typeof notifSmsMap === 'object' ? notifSmsMap : {};
      map[id] = { text, code: code || '', time: Date.now() };
      // 最多保留50条映射
      const entries = Object.entries(map);
      if (entries.length > 50) {
        entries.sort((a, b) => a[1].time - b[1].time);
        const toRemove = entries.slice(0, entries.length - 50).map(([k]) => k);
        toRemove.forEach(k => delete map[k]);
      }
      await SharedStorage.setLocal({ [NOTIF_MAP_KEY]: map });
    } catch (e) {
      // 忽略映射写入错误
    }
  }

  async function readNotificationPayload(id) {
    const { [NOTIF_MAP_KEY]: notifSmsMap } = await SharedStorage.getLocal([NOTIF_MAP_KEY]);
    const entry = notifSmsMap && notifSmsMap[id];
    return entry ? { text: entry.text || '', code: entry.code || '' } : null;
  }

  async function removeNotificationPayload(id) {
    try {
      const { [NOTIF_MAP_KEY]: notifSmsMap } = await SharedStorage.getLocal([NOTIF_MAP_KEY]);
      if (notifSmsMap && notifSmsMap[id]) {
        delete notifSmsMap[id];
        await SharedStorage.setLocal({ [NOTIF_MAP_KEY]: notifSmsMap });
      }
    } catch (_) {}
  }

  async function copyFromNotification(notificationId) {
    const payload = await readNotificationPayload(notificationId);
    const text = payload ? payload.text : '';
    if (!text) return;
    try {
      await copyToClipboardViaInjection(text);
    } catch (e) {
      logError(`[Clipboard] 复制失败: ${e && e.message ? e.message : String(e)}`);
    }
  }

  async function copyToClipboardViaInjection(text) {
    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    });
    const targetTab = tabs && tabs[0];
    if (!targetTab) {
      throw new Error('无活动标签页可用于复制');
    }
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      args: [text],
      func: (txt) => {
        try {
          navigator.clipboard.writeText(txt).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = txt;
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
          });
        } catch (_) {
          const ta = document.createElement('textarea');
          ta.value = txt;
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
      }
    });
  }

  // --------------------------- 验证码自动填充模块 ---------------------------

  function tryAutoFillCode(code, sms) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return;

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [code],
        func: fillCodeInPage
      }).then((results) => {
        if (results && results[0] && results[0].result === true) {
          logError(`[AutoFill] 验证码 ${code} 已自动填入页面`);
        }
      }).catch((e) => {
        logError(`[AutoFill] 注入失败: ${e && e.message ? e.message : String(e)}`);
      });
    });
  }

  // 此函数会被注入到页面中执行，不能引用外部变量
  function fillCodeInPage(code) {
    const KEYWORDS = [
      'code', 'verify', 'verification', 'captcha', 'otp', 'pin',
      'authcode', 'auth-code', 'auth_code', 'security', 'token', 'sms',
      '验证码', '验证', '动态码', '校验码', '安全码', '认证码', '确认码'
    ];

    function isVisible(el) {
      if (!el || !el.getClientRects) return false;
      const rects = el.getClientRects();
      if (!rects.length) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      return true;
    }

    function findAssociatedLabel(inp) {
      if (inp.id) {
        const label = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        if (label) return label.textContent || '';
      }
      let parent = inp.parentElement;
      while (parent) {
        if (parent.tagName === 'LABEL') return parent.textContent || '';
        parent = parent.parentElement;
      }
      const labelledBy = inp.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.textContent || '';
      }
      return '';
    }

    function scoreInput(inp) {
      let score = 0;
      const attrs = [
        inp.id || '', inp.name || '', inp.placeholder || '',
        inp.getAttribute('aria-label') || '', inp.getAttribute('autocomplete') || ''
      ].join(' ').toLowerCase();

      for (const kw of KEYWORDS) {
        if (attrs.includes(kw.toLowerCase())) { score += 3; break; }
      }

      const maxLen = parseInt(inp.getAttribute('maxlength') || '0', 10);
      if (maxLen >= 4 && maxLen <= 8) score += 2;

      const inputMode = inp.getAttribute('inputmode') || '';
      if (inputMode === 'numeric' || inputMode === 'digits') score += 1;

      const labelText = findAssociatedLabel(inp).toLowerCase();
      for (const kw of KEYWORDS) {
        if (labelText.includes(kw.toLowerCase())) { score += 3; break; }
      }

      const parentText = (inp.parentElement ? inp.parentElement.textContent : '').toLowerCase().substring(0, 200);
      for (const kw of KEYWORDS) {
        if (parentText.includes(kw.toLowerCase())) { score += 1; break; }
      }

      return score;
    }

    function findCodeInput() {
      // Strategy 1: autocomplete="one-time-code"
      let input = document.querySelector('input[autocomplete="one-time-code"]');
      if (input && isVisible(input) && !input.disabled && !input.readOnly) return input;

      // Strategy 2: Score-based detection
      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
      ));
      let best = null;
      let bestScore = 0;
      for (const inp of inputs) {
        if (!isVisible(inp) || inp.disabled || inp.readOnly) continue;
        const s = scoreInput(inp);
        if (s > bestScore) { bestScore = s; best = inp; }
      }
      return bestScore >= 2 ? best : null;
    }

    function flashBorder(el) {
      const orig = {
        border: el.style.border,
        boxShadow: el.style.boxShadow,
        transition: el.style.transition,
        outline: el.style.outline
      };
      el.style.transition = 'border 0.3s ease, box-shadow 0.3s ease, outline 0.3s ease';
      el.style.border = '2px solid #28a745';
      el.style.boxShadow = '0 0 0 3px rgba(40, 167, 69, 0.3)';
      el.style.outline = 'none';
      setTimeout(function() {
        el.style.border = orig.border;
        el.style.boxShadow = orig.boxShadow;
        el.style.transition = orig.transition;
        el.style.outline = orig.outline;
      }, 1500);
    }

    var input = findCodeInput();
    if (!input) return false;

    // Use native setter for React/Vue compatibility
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, code);

    // Trigger events
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Visual feedback
    flashBorder(input);
    input.focus();

    return true;
  }