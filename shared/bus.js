(function() {
  const g = typeof window !== 'undefined' ? window : self;
  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage;

  const Types = {
    SMS_LIST_UPDATED: 'smsListUpdated'
  };

  const handlers = new Map(); // type => Set<fn>

  function on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
  }

  function off(type, handler) {
    if (handlers.has(type)) {
      handlers.get(type).delete(handler);
    }
  }

  function send(type, payload) {
    if (!hasChrome) {
      // 在非扩展环境（如预览）中静默
      return;
    }
    chrome.runtime.sendMessage({ type, payload });
  }

  if (hasChrome) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return;
      const set = handlers.get(message.type);
      if (set && set.size) {
        set.forEach((cb) => {
          try { cb(message.payload, sender, sendResponse); } catch (e) { /* ignore */ }
        });
      }
    });
  }

  g.SharedBus = { Types, on, off, send };
})();