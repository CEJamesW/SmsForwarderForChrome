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
      const settings = await SharedStorage.getSync(['autoFillCode', 'customCodePattern', 'autoFillPhone', 'phoneNumber', 'phoneCountryCode']);
      const autoFillEnabled = settings.autoFillCode !== false; // 默认开启
      const customPattern = settings.customCodePattern || '';
      const autoFillPhoneEnabled = settings.autoFillPhone !== false; // 默认开启
      const phoneNumber = settings.phoneNumber || '';
      const phoneCountryCode = settings.phoneCountryCode || '+86';

      // 提取验证码并触发通知（逐条）
      try {
        await Promise.all(newItems.map(async (item) => {
          const code = SharedCodeUtil.extractVerificationCode(item.content, customPattern);
          if (code) {
            item.extractedCode = code;
            logError(`[CodeExtract] 成功提取验证码: ${code} (来源: ${item.number || item.from || '未知'})`);
            if (autoFillEnabled) {
              tryAutoFillCode(code, item);
            }
          } else {
            logError(`[CodeExtract] 未能提取验证码，内容: ${(item.content || '').substring(0, 100)}`);
          }
          // 如果启用了手机号自动填充且有手机号，尝试填充
          if (autoFillPhoneEnabled && phoneNumber) {
            tryAutoFillPhone(phoneNumber, phoneCountryCode);
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
    // 如果未传入 code，尝试再次提取（兜底）
    if (!code && sms.content) {
      const settings = await SharedStorage.getSync(['customCodePattern']);
      code = SharedCodeUtil.extractVerificationCode(sms.content, settings.customCodePattern || '');
    }
    if (!code) code = sms.extractedCode || null;

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
    let targetTab = tabs && tabs[0];
    if (!targetTab) {
      // 回退：取任意标签页
      const allTabs = await new Promise((resolve) => {
        chrome.tabs.query({}, resolve);
      });
      targetTab = allTabs && allTabs[0];
    }
    if (!targetTab) {
      throw new Error('无可用标签页用于复制');
    }
    // 激活标签页以确保剪贴板权限可用
    try {
      await chrome.tabs.update(targetTab.id, { active: true });
    } catch (_) {}
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id, allFrames: false },
      args: [text],
      func: (txt) => {
        try {
          navigator.clipboard.writeText(txt).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.position = 'fixed';
            ta.style.top = '0';
            ta.style.left = '0';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
          });
        } catch (_) {
          const ta = document.createElement('textarea');
          ta.value = txt;
          ta.style.position = 'fixed';
          ta.style.top = '0';
          ta.style.left = '0';
          ta.style.opacity = '0';
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
      if (!tab || !tab.id) {
        logError(`[AutoFill] 无活动标签页，验证码 ${code} 未填入`);
        return;
      }

      // 注入到所有框架（含 iframe），提高验证码输入框命中率
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        args: [code],
        func: fillCodeInPage
      }).then((results) => {
        let filled = false;
        if (results) {
          for (const r of results) {
            if (r && r.result === true) { filled = true; break; }
          }
        }
        if (filled) {
          logError(`[AutoFill] 验证码 ${code} 已自动填入页面 (tab=${tab.id})`);
        } else {
          logError(`[AutoFill] 未找到验证码输入框，验证码 ${code} 未填入 (tab=${tab.id}, url=${tab.url || ''})`);
        }
      }).catch((e) => {
        logError(`[AutoFill] 注入失败: ${e && e.message ? e.message : String(e)}`);
      });
    });
  }

  // 此函数会被注入到页面中执行，不能引用外部变量
  function fillCodeInPage(code) {
    var KEYWORDS = [
      'code', 'verify', 'verification', 'captcha', 'otp', 'pin',
      'authcode', 'auth-code', 'auth_code', 'security', 'token', 'sms',
      '验证码', '验证', '动态码', '校验码', '安全码', '认证码', '确认码', '短信码'
    ];
    var SKIP_TYPES = ['password','submit','button','checkbox','radio','file','hidden','range','color','image','reset','email','url','date','time','datetime-local','month','week'];

    function isVisible(el) {
      if (!el || !el.getClientRects) return false;
      var rects = el.getClientRects();
      if (!rects.length) return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      return true;
    }

    function findAssociatedLabel(inp) {
      if (inp.id) {
        var label = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        if (label) return label.textContent || '';
      }
      var parent = inp.parentElement;
      while (parent) {
        if (parent.tagName === 'LABEL') return parent.textContent || '';
        parent = parent.parentElement;
      }
      var labelledBy = inp.getAttribute('aria-labelledby');
      if (labelledBy) {
        var labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.textContent || '';
      }
      return '';
    }

    function scoreInput(inp) {
      var score = 0;
      var attrs = [
        inp.id || '', inp.name || '', inp.placeholder || '',
        inp.getAttribute('aria-label') || '', inp.getAttribute('autocomplete') || ''
      ].join(' ').toLowerCase();

      // autocomplete="one-time-code" 是最强信号
      if ((inp.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') { score += 10; }

      for (var i = 0; i < KEYWORDS.length; i++) {
        if (attrs.indexOf(KEYWORDS[i].toLowerCase()) >= 0) { score += 3; break; }
      }

      var maxLen = parseInt(inp.getAttribute('maxlength') || '0', 10);
      if (maxLen >= 4 && maxLen <= 8) score += 2;

      var inputMode = inp.getAttribute('inputmode') || '';
      var type = (inp.type || 'text').toLowerCase();
      if (inputMode === 'numeric' || inputMode === 'digits' || type === 'tel' || type === 'number') score += 1;

      var labelText = findAssociatedLabel(inp).toLowerCase();
      for (var i2 = 0; i2 < KEYWORDS.length; i2++) {
        if (labelText.indexOf(KEYWORDS[i2].toLowerCase()) >= 0) { score += 3; break; }
      }

      // 检查附近文本（父元素及祖父元素）
      var parentText = '';
      var p = inp.parentElement;
      if (p) parentText = (p.textContent || '').toLowerCase().substring(0, 300);
      for (var i3 = 0; i3 < KEYWORDS.length; i3++) {
        if (parentText.indexOf(KEYWORDS[i3].toLowerCase()) >= 0) { score += 1; break; }
      }

      // 空值加分（更可能是目标输入框）
      if (!inp.value) score += 1;

      return score;
    }

    function findCodeInput() {
      // 策略1: autocomplete="one-time-code"
      var input = document.querySelector('input[autocomplete="one-time-code"]');
      if (input && isVisible(input) && !input.disabled && !input.readOnly) return input;

      // 策略2: 评分检测所有文本类输入框
      var inputs = Array.from(document.querySelectorAll('input'));
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (!isVisible(inp) || inp.disabled || inp.readOnly) continue;
        var type = (inp.type || 'text').toLowerCase();
        if (SKIP_TYPES.indexOf(type) >= 0) continue;
        var s = scoreInput(inp);
        if (s > bestScore) { bestScore = s; best = inp; }
      }
      return bestScore >= 2 ? best : null;
    }

    function flashBorder(el) {
      var orig = {
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

    function setNativeValue(el, value) {
      var descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
    }

    function triggerEvents(el, val) {
      // 使用 InputEvent 提供更好的框架兼容性
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
      } catch (_) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // 部分框架监听键盘事件
      try {
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      } catch (_) {}
    }

    function doFill(inp) {
      // 截断到 maxlength
      var maxLen = parseInt(inp.getAttribute('maxlength') || '0', 10);
      var fillValue = (maxLen > 0 && code.length > maxLen) ? code.substring(0, maxLen) : code;

      inp.focus();
      setNativeValue(inp, fillValue);
      triggerEvents(inp, fillValue);

      // 验证值是否生效；未生效则重试
      if (inp.value !== fillValue) {
        setNativeValue(inp, fillValue);
        try {
          inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: fillValue }));
        } catch(_) {
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 最后兜底：直接赋值
      if (inp.value !== fillValue) {
        inp.value = fillValue;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }

      flashBorder(inp);
      return inp.value === fillValue;
    }

    var input = findCodeInput();
    if (!input) return false;

    var ok = doFill(input);

    // 框架可能在重渲染后重置值，延迟重试一次
    if (!ok) {
      setTimeout(function() {
        try { doFill(input); } catch(_) {}
      }, 200);
    }

    return true;
  }

  // --------------------------- 手机号自动填充模块 ---------------------------

  function tryAutoFillPhone(phoneNumber, countryCode) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        logError(`[AutoFillPhone] 无活动标签页，手机号未填入`);
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        args: [phoneNumber, countryCode],
        func: fillPhoneInPage
      }).then((results) => {
        let filled = false;
        let dropdownSet = false;
        if (results) {
          for (const r of results) {
            if (r && r.result) {
              if (r.result.filled) filled = true;
              if (r.result.dropdownSet) dropdownSet = true;
            }
          }
        }
        if (filled || dropdownSet) {
          logError(`[AutoFillPhone] 手机号${filled ? '已填入' : '未填入'}${dropdownSet ? '，区号已设置' : ''} (tab=${tab.id})`);
        } else {
          logError(`[AutoFillPhone] 未找到手机号输入框 (tab=${tab.id}, url=${tab.url || ''})`);
        }
      }).catch((e) => {
        logError(`[AutoFillPhone] 注入失败: ${e && e.message ? e.message : String(e)}`);
      });
    });
  }

  // 此函数会被注入到页面中执行，不能引用外部变量
  function fillPhoneInPage(phoneNumber, countryCode) {
    var PHONE_KEYWORDS = [
      'phone', 'mobile', 'tel', 'telephone', 'cellphone',
      '手机', '电话', '号码', '手机号', '手机号码', '联系号码', '联系电话'
    ];
    var SKIP_TYPES = ['password','submit','button','checkbox','radio','file','hidden','range','color','image','reset','email','url','date','time','datetime-local','month','week','search'];

    function isVisible(el) {
      if (!el || !el.getClientRects) return false;
      var rects = el.getClientRects();
      if (!rects.length) return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      return true;
    }

    function findAssociatedLabel(inp) {
      if (inp.id) {
        var label = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        if (label) return label.textContent || '';
      }
      var parent = inp.parentElement;
      while (parent) {
        if (parent.tagName === 'LABEL') return parent.textContent || '';
        parent = parent.parentElement;
      }
      var labelledBy = inp.getAttribute('aria-labelledby');
      if (labelledBy) {
        var labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.textContent || '';
      }
      return '';
    }

    function scorePhoneInput(inp) {
      var score = 0;
      var attrs = [
        inp.id || '', inp.name || '', inp.placeholder || '',
        inp.getAttribute('aria-label') || '', inp.getAttribute('autocomplete') || ''
      ].join(' ').toLowerCase();

      // autocomplete="tel" 是最强信号
      if ((inp.getAttribute('autocomplete') || '').toLowerCase() === 'tel') score += 10;
      if ((inp.getAttribute('autocomplete') || '').toLowerCase() === 'tel-national') score += 10;

      for (var i = 0; i < PHONE_KEYWORDS.length; i++) {
        if (attrs.indexOf(PHONE_KEYWORDS[i].toLowerCase()) >= 0) { score += 3; break; }
      }

      var type = (inp.type || 'text').toLowerCase();
      if (type === 'tel') score += 3;

      var maxLen = parseInt(inp.getAttribute('maxlength') || '0', 10);
      if (maxLen === 11) score += 3; // 中国手机号正好11位
      else if (maxLen >= 10 && maxLen <= 13) score += 1;

      var inputMode = inp.getAttribute('inputmode') || '';
      if (inputMode === 'numeric' || inputMode === 'tel') score += 1;

      var labelText = findAssociatedLabel(inp).toLowerCase();
      for (var i2 = 0; i2 < PHONE_KEYWORDS.length; i2++) {
        if (labelText.indexOf(PHONE_KEYWORDS[i2].toLowerCase()) >= 0) { score += 3; break; }
      }

      // 检查附近文本
      var parentText = '';
      var p = inp.parentElement;
      if (p) parentText = (p.textContent || '').toLowerCase().substring(0, 300);
      for (var i3 = 0; i3 < PHONE_KEYWORDS.length; i3++) {
        if (parentText.indexOf(PHONE_KEYWORDS[i3].toLowerCase()) >= 0) { score += 1; break; }
      }

      // 空值加分
      if (!inp.value) score += 2;

      // 排除验证码类输入框
      var codeKeywords = ['code', 'verify', 'verification', 'captcha', 'otp', 'pin', '验证码', '校验码', '动态码'];
      for (var ci = 0; ci < codeKeywords.length; ci++) {
        if (attrs.indexOf(codeKeywords[ci].toLowerCase()) >= 0) { score -= 5; break; }
        if (labelText.indexOf(codeKeywords[ci].toLowerCase()) >= 0) { score -= 5; break; }
      }

      return score;
    }

    function findPhoneInput() {
      // 策略1: autocomplete="tel" 或 "tel-national"
      var input = document.querySelector('input[autocomplete="tel"], input[autocomplete="tel-national"]');
      if (input && isVisible(input) && !input.disabled && !input.readOnly && !input.value) return input;

      // 策略2: type="tel"
      var telInputs = document.querySelectorAll('input[type="tel"]');
      for (var t = 0; t < telInputs.length; t++) {
        if (isVisible(telInputs[t]) && !telInputs[t].disabled && !telInputs[t].readOnly && !telInputs[t].value) return telInputs[t];
      }

      // 策略3: 评分检测所有输入框
      var inputs = Array.from(document.querySelectorAll('input'));
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (!isVisible(inp) || inp.disabled || inp.readOnly) continue;
        var type = (inp.type || 'text').toLowerCase();
        if (SKIP_TYPES.indexOf(type) >= 0) continue;
        if (inp.value) continue; // 跳过已有值的输入框
        var s = scorePhoneInput(inp);
        if (s > bestScore) { bestScore = s; best = inp; }
      }
      return bestScore >= 3 ? best : null;
    }

    function setNativeValue(el, value) {
      var descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
    }

    function triggerEvents(el, val) {
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
      } catch (_) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      } catch (_) {}
    }

    function flashBorder(el) {
      var orig = {
        border: el.style.border,
        boxShadow: el.style.boxShadow,
        transition: el.style.transition,
        outline: el.style.outline
      };
      el.style.transition = 'border 0.3s ease, box-shadow 0.3s ease, outline 0.3s ease';
      el.style.border = '2px solid #4285f4';
      el.style.boxShadow = '0 0 0 3px rgba(66, 133, 244, 0.3)';
      el.style.outline = 'none';
      setTimeout(function() {
        el.style.border = orig.border;
        el.style.boxShadow = orig.boxShadow;
        el.style.transition = orig.transition;
        el.style.outline = orig.outline;
      }, 1500);
    }

    // 检测并设置区号下拉框
    function trySetCountryCodeDropdown(countryCode) {
      var cc = countryCode || '+86';
      var ccDigits = cc.replace(/\+/g, ''); // "86"

      // 策略1: 原生 select 元素
      var selects = document.querySelectorAll('select');
      for (var s = 0; s < selects.length; s++) {
        var sel = selects[s];
        if (!isVisible(sel)) continue;
        var options = sel.querySelectorAll('option');
        var bestIdx = -1;
        var bestScore = -1;
        for (var o = 0; o < options.length; o++) {
          var optText = (options[o].textContent || '').toLowerCase();
          var optVal = (options[o].value || '').toLowerCase();
          var sc = -1;
          // 精确匹配 +86 或 86
          if (optText.indexOf(cc.toLowerCase()) >= 0 || optVal.indexOf(cc.toLowerCase()) >= 0) sc = 10;
          else if (optText.indexOf(ccDigits) >= 0 || optVal.indexOf(ccDigits) >= 0) sc = 8;
          // 匹配 China/中国/CN
          else if (optText.indexOf('china') >= 0 || optText.indexOf('中国') >= 0 || optText.indexOf('cn') >= 0) sc = 5;
          if (sc > bestScore) { bestScore = sc; bestIdx = o; }
        }
        if (bestIdx >= 0 && bestScore >= 5) {
          // 检查这个 select 是否像区号选择器（选项中有+号或国家名）
          var selectLooksLikeCC = false;
          for (var o2 = 0; o2 < options.length; o2++) {
            var t = (options[o2].textContent || '');
            if (t.indexOf('+') >= 0 || t.indexOf('中国') >= 0 || t.toLowerCase().indexOf('china') >= 0) {
              selectLooksLikeCC = true;
              break;
            }
          }
          if (selectLooksLikeCC) {
            sel.selectedIndex = bestIdx;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }

      // 策略2: 自定义下拉框（div/button/span 类组件）
      // 查找包含 "+86" 或中国国旗的可点击元素
      var clickableSelectors = 'div[role="combobox"], div[role="listbox"], div[class*="country"], div[class*="select"], button[class*="country"], span[class*="country"], div[tabindex]';
      var clickables = document.querySelectorAll(clickableSelectors);
      for (var c = 0; c < clickables.length; c++) {
        var el = clickables[c];
        if (!isVisible(el)) continue;
        var text = (el.textContent || '').trim();
        if (text.indexOf(cc) >= 0 || text.indexOf('+86') >= 0 || text.indexOf('中国') >= 0) {
          // 如果文本已经显示 +86，可能已经选中了
          if (text.indexOf(cc) >= 0 && text.length < 20) return true;
          // 否则点击展开下拉框
          try {
            el.click();
            // 等待下拉选项出现后点击对应项
            setTimeout(function() {
              var items = document.querySelectorAll('div[role="option"], li[role="option"], div[class*="option"], li[class*="option"]');
              for (var ii = 0; ii < items.length; ii++) {
                var itemText = (items[ii].textContent || '').toLowerCase();
                if (itemText.indexOf(cc.toLowerCase()) >= 0 || itemText.indexOf('中国') >= 0 || itemText.indexOf('china') >= 0) {
                  items[ii].click();
                  break;
                }
              }
            }, 300);
            return true;
          } catch(_) {}
        }
      }

      return false;
    }

    // 清理手机号：只保留数字
    var cleanPhone = phoneNumber.replace(/\D/g, '');
    // 如果以86开头且是13位，去掉86前缀
    if (cleanPhone.length === 13 && cleanPhone.indexOf('86') === 0) {
      cleanPhone = cleanPhone.substring(2);
    }

    var result = { filled: false, dropdownSet: false };

    // 先尝试设置区号下拉框
    result.dropdownSet = trySetCountryCodeDropdown(countryCode);

    // 查找并填充手机号输入框
    var input = findPhoneInput();
    if (input) {
      input.focus();
      setNativeValue(input, cleanPhone);
      triggerEvents(input, cleanPhone);

      // 验证值是否生效
      if (input.value !== cleanPhone) {
        setNativeValue(input, cleanPhone);
        try {
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cleanPhone }));
        } catch(_) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (input.value !== cleanPhone) {
        input.value = cleanPhone;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      flashBorder(input);
      result.filled = input.value === cleanPhone;

      // 延迟重试
      if (!result.filled) {
        setTimeout(function() {
          try {
            setNativeValue(input, cleanPhone);
            triggerEvents(input, cleanPhone);
            flashBorder(input);
          } catch(_) {}
        }, 200);
      }
    }

    return result;
  }