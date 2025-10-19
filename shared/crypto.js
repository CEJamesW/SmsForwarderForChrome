(function() {
  async function hmacSHA256(message, key) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);

    const subtle = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
      ? globalThis.crypto.subtle
      : null;
    if (!subtle) throw new Error('Crypto.subtle not available');

    const cryptoKey = await subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await subtle.sign('HMAC', cryptoKey, messageData);
    const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return encodeURIComponent(base64Signature);
  }

  async function generateSign(secret, timestamp) {
    return await hmacSHA256(`${timestamp}\n${secret}`, secret);
  }

  const g = typeof window !== 'undefined' ? window : self;
  g.SharedCrypto = { hmacSHA256, generateSign };
})();