(function() {
  const DEFAULT_TIMEOUT_MS = 10000;
  const DEFAULT_RETRIES = 2;

  async function signedPost(serverUrl, path, secret, data, opts = {}) {
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const retries = typeof opts.retries === 'number' ? opts.retries : DEFAULT_RETRIES;

    const timestamp = Date.now().toString();
    const sign = await SharedCrypto.generateSign(secret, timestamp);

    const url = serverUrl + path;
    const body = {
      data,
      timestamp: parseInt(timestamp, 10),
      sign
    };

    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      mode: 'cors',
      credentials: 'same-origin'
    };

    return await retryableFetch(url, init, retries);
  }

  async function retryableFetch(url, init, retries) {
    let attempt = 0;
    while (true) {
      try {
        const resp = await fetch(url, init);
        if (!resp.ok && resp.status >= 500 && attempt < retries) {
          await delay(backoff(attempt));
          attempt++;
          continue;
        }
        return resp;
      } catch (err) {
        if (attempt < retries) {
          await delay(backoff(attempt));
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function backoff(i) {
    const base = 200;
    const jitter = Math.random() * 160;
    return base * Math.pow(2, i) + jitter;
  }

  const g = typeof window !== 'undefined' ? window : self;
  g.SharedApi = { signedPost };
})();