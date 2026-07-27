(function() {
  const g = typeof window !== 'undefined' ? window : self;

  const DEFAULT_CODE_PATTERNS = [
    // Chinese: keyword + separator + digits
    /验证码[：:\s是为约]*([0-9]{4,8})/i,
    /校验码[：:\s是为约]*([0-9]{4,8})/i,
    /动态码[：:\s是为约]*([0-9]{4,8})/i,
    /验证代码[：:\s是为约]*([0-9]{4,8})/i,
    /安全码[：:\s是为约]*([0-9]{4,8})/i,
    /认证码[：:\s是为约]*([0-9]{4,8})/i,
    /确认码[：:\s是为约]*([0-9]{4,8})/i,
    /取件码[：:\s是为约]*([0-9]{4,8})/i,
    /激活码[：:\s是为约]*([0-9]{4,8})/i,
    // English
    /(?:verification|verify|security|authentication)[\s]*code[\s:is]*([0-9]{4,8})/i,
    /(?:one[\s-]*time)[\s]*(?:password|code|pin)[\s:is]*([0-9]{4,8})/i,
    /(?:otp|pin)[\s:is]*([0-9]{4,8})/i,
    /code[\s:is]*([0-9]{4,8})/i,
    // Bracketed: 【验证码】123456 or [code] 123456
    /[\u3010\[][\w\u4e00-\u9fff]*[\u3011\]][\s:]*([0-9]{4,8})/,
    // Generic standalone 4-8 digit number (lowest priority fallback)
    /\b([0-9]{4,8})\b/
  ];

  function extractVerificationCode(text, customPattern) {
    if (!text || typeof text !== 'string') return null;

    if (customPattern) {
      try {
        const re = new RegExp(customPattern);
        const m = text.match(re);
        if (m && m[1]) return m[1];
        if (m && m[0]) return m[0];
      } catch (_) {}
    }

    for (const pattern of DEFAULT_CODE_PATTERNS) {
      const match = text.match(pattern);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  g.SharedCodeUtil = {
    extractVerificationCode,
    DEFAULT_CODE_PATTERNS
  };
})();
