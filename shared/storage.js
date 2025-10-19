(function() {
  function resolveArea(kind) {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.storage) {
        if (kind === 'sync') return chrome.storage.sync || null;
        if (kind === 'local') return chrome.storage.local || null;
        if (kind === 'session') return (chrome.storage.session || chrome.storage.local || null);
      }
    } catch (_) {}
    return null;
  }

  function get(areaKind, keys) {
    const area = resolveArea(areaKind);
    return new Promise((resolve) => {
      if (!area || typeof area.get !== 'function') {
        resolve({});
        return;
      }
      try {
        area.get(keys, resolve);
      } catch (_) {
        resolve({});
      }
    });
  }

  function set(areaKind, obj) {
    const area = resolveArea(areaKind);
    return new Promise((resolve) => {
      if (!area || typeof area.set !== 'function') {
        resolve();
        return;
      }
      try {
        area.set(obj, resolve);
      } catch (_) {
        resolve();
      }
    });
  }

  function remove(areaKind, keys) {
    const area = resolveArea(areaKind);
    return new Promise((resolve) => {
      if (!area || typeof area.remove !== 'function') {
        resolve();
        return;
      }
      try {
        area.remove(keys, resolve);
      } catch (_) {
        resolve();
      }
    });
  }

  function getSync(keys) { return get('sync', keys); }
  function setSync(obj) { return set('sync', obj); }
  function removeSync(keys) { return remove('sync', keys); }

  function getLocal(keys) { return get('local', keys); }
  function setLocal(obj) { return set('local', obj); }
  function removeLocal(keys) { return remove('local', keys); }

  function getSession(keys) { return get('session', keys); }
  function setSession(obj) { return set('session', obj); }
  function removeSession(keys) { return remove('session', keys); }

  const g = typeof window !== 'undefined' ? window : self;
  g.SharedStorage = { getSync, setSync, removeSync, getLocal, setLocal, removeLocal, getSession, setSession, removeSession };
})();