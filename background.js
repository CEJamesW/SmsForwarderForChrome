importScripts('shared/crypto.js', 'shared/api.js', 'shared/storage.js', 'shared/bus.js');
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
      // 触发浏览器通知（逐条）
      try {
        await Promise.all(newItems.map(item => notifyNewSms(item)));
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

  async function notifyNewSms(sms) {
    const contact = sms.name || sms.contact || '新短信';
    const number = sms.number || sms.from || sms.to || '';
    const title = number ? `${contact} (${number})` : contact;
    const message = sms.content || '';
    const notificationId = `sms-notif-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    // 保存待复制的内容
    await storeNotificationPayload(notificationId, message);

    // 创建通知（带复制按钮）
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('images/icon48.png'),
      title,
      message,
      contextMessage: '来源: SmsForwarder',
      requireInteraction: true,
      isClickable: true,
      priority: 2,
      buttons: [
        { title: '📋 复制短信' }
      ]
    }, (createdId) => {
      if (chrome.runtime.lastError) {
        logError(`[Notify] 创建失败: ${chrome.runtime.lastError.message}`);
      }
    });
  }

  chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    if (buttonIndex === 0) {
      await copyFromNotification(notificationId);
      // 复制后清理并关闭通知
      try {
        await removeNotificationPayload(notificationId);
        chrome.notifications.clear(notificationId);
      } catch (e) {
        // 忽略清理错误
      }
    }
  });

  chrome.notifications.onClosed.addListener(async (notificationId, byUser) => {
    // 通知关闭后清理映射
    try {
      await removeNotificationPayload(notificationId);
    } catch (_) {}
  });

  async function storeNotificationPayload(id, text) {
    try {
      const { [NOTIF_MAP_KEY]: notifSmsMap } = await SharedStorage.getLocal([NOTIF_MAP_KEY]);
      const map = notifSmsMap && typeof notifSmsMap === 'object' ? notifSmsMap : {};
      map[id] = { text, time: Date.now() };
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
    return entry && entry.text ? entry.text : '';
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
    const text = await readNotificationPayload(notificationId);
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