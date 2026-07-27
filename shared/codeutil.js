(function() {
  const g = typeof window !== 'undefined' ? window : self;

  // 关键词模式：关键词 + 分隔符 + 4-8位数字
  const DEFAULT_CODE_PATTERNS = [
    // 中文关键词（高优先级）
    /验证码[：:\s是为约]*([0-9]{4,8})/i,
    /校验码[：:\s是为约]*([0-9]{4,8})/i,
    /动态码[：:\s是为约]*([0-9]{4,8})/i,
    /验证代码[：:\s是为约]*([0-9]{4,8})/i,
    /安全码[：:\s是为约]*([0-9]{4,8})/i,
    /认证码[：:\s是为约]*([0-9]{4,8})/i,
    /确认码[：:\s是为约]*([0-9]{4,8})/i,
    /取件码[：:\s是为约]*([0-9]{4,8})/i,
    /激活码[：:\s是为约]*([0-9]{4,8})/i,
    /短信码[：:\s是为约]*([0-9]{4,8})/i,
    // 数字在前 + 中文关键词（"123456是你的验证码"）
    /([0-9]{4,8})[\s是为]*你的?验证码/i,
    /([0-9]{4,8})[\s是为]*你的?校验码/i,
    /([0-9]{4,8})[\s是为]*你的?动态码/i,
    // 英文
    /(?:verification|verify|security|authentication)[\s]*code[\s:is]*([0-9]{4,8})/i,
    /(?:one[\s-]*time)[\s]*(?:password|code|pin)[\s:is]*([0-9]{4,8})/i,
    /(?:otp|pin)[\s:is]*([0-9]{4,8})/i,
    /code[\s:is]*([0-9]{4,8})/i,
    // 括号格式: 【验证码】123456 or [code] 123456
    /[\u3010\[][\w\u4e00-\u9fff]*[\u3011\]][\s:]*([0-9]{4,8})/,
    // "is 123456" / "为 123456" / "是 123456" (紧跟在"验证码"等词后面但中间有其他字)
    /(?:验证码|校验码|动态码|安全码).{0,10}?([0-9]{4,8})/i,
  ];

  // 智能提取的关键词列表（用于距离评分）
  const SMART_KEYWORDS = [
    '验证码', '校验码', '动态码', '验证', '安全码', '认证码', '确认码', '短信码', '激活码',
    'code', 'verify', 'verification', 'otp', 'pin', 'security', 'captcha', 'auth'
  ];

  // 不应作为验证码的数字模式
  function isLikelyNotCode(numStr, text) {
    var n = parseInt(numStr, 10);
    // 年份 2019-2030
    if (numStr.length === 4 && n >= 2019 && n <= 2030) return true;
    // 中国手机号片段（11位以1开头，取前4位时1xx开头）
    if (numStr.length >= 11) return true;
    // 时间格式如 1234 (可能是 12:34)
    return false;
  }

  // 智能回退：分析所有 4-8 位数字序列，按与关键词距离评分
  function smartFallback(text) {
    var textLower = text.toLowerCase();
    var hasCodeSemantics = SMART_KEYWORDS.some(function(keyword) {
      return textLower.indexOf(keyword.toLowerCase()) >= 0;
    });
    if (!hasCodeSemantics) return null;

    // 不使用 \b 词边界，因为中文字符与数字之间不一定有词边界
    var digitRe = /(\d{4,8})/g;
    var candidates = [];
    var dm;
    while ((dm = digitRe.exec(text)) !== null) {
      var num = dm[1];
      // 检查前后是否还有更多数字（说明是更长数字的一部分，跳过）
      var afterIdx = dm.index + dm[0].length;
      if (afterIdx < text.length && /\d/.test(text[afterIdx])) continue;
      if (dm.index > 0 && /\d/.test(text[dm.index - 1])) continue;
      if (isLikelyNotCode(num, text)) continue;
      candidates.push({ code: num, index: dm.index });
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].code;

    // 多个候选：按与关键词的距离评分
    var best = null;
    var bestScore = -1;

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var score = 0;

      // 检查与每个关键词的距离
      for (var k = 0; k < SMART_KEYWORDS.length; k++) {
        var kwLower = SMART_KEYWORDS[k].toLowerCase();
        var searchFrom = 0;
        var kwIdx;
        while ((kwIdx = textLower.indexOf(kwLower, searchFrom)) >= 0) {
          var dist = Math.abs(c.index - kwIdx);
          if (dist < 30) { score += 10; }
          else if (dist < 60) { score += 5; }
          else if (dist < 120) { score += 2; }
          searchFrom = kwIdx + kwLower.length;
        }
      }

      // 偏好 6 位数字（最常见验证码长度）
      if (c.code.length === 6) score += 3;
      else if (c.code.length === 4) score += 1;
      else if (c.code.length === 5) score += 1;

      if (score > bestScore) { bestScore = score; best = c; }
    }

    // 没有验证码语义时不要猜测，避免把订单号、金额或年份自动填入表单。
    if (bestScore <= 0) {
      return null;
    }

    return best ? best.code : candidates[0].code;
  }

  function extractVerificationCode(text, customPattern) {
    if (!text || typeof text !== 'string') return null;

    // 1. 自定义正则优先
    if (customPattern) {
      try {
        var re = new RegExp(customPattern);
        var m = text.match(re);
        if (m && m[1]) return m[1];
        if (m && m[0]) return m[0];
      } catch (_) {}
    }

    // 2. 关键词模式匹配
    for (var i = 0; i < DEFAULT_CODE_PATTERNS.length; i++) {
      var match = text.match(DEFAULT_CODE_PATTERNS[i]);
      if (match && match[1]) return match[1];
    }

    // 3. 智能回退：分析所有数字序列
    return smartFallback(text);
  }

  g.SharedCodeUtil = {
    extractVerificationCode,
    DEFAULT_CODE_PATTERNS,
    SMART_KEYWORDS
  };
})();
