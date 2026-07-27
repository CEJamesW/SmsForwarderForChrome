(function() {
  'use strict';

  if (window.__smsForwarderAutofillLoaded) return;
  window.__smsForwarderAutofillLoaded = true;

  var state = {
    code: '',
    codeExpiresAt: 0,
    autoFillCode: true,
    observerTimer: null
  };
  var lastContextTarget = null;

  var PHONE_WORDS = ['phone', 'mobile', 'telephone', 'cellphone', '手机号', '手机号码', '联系电话', '电话号码'];
  var CODE_WORDS = ['one-time-code', 'otp', 'verification', 'verify', 'authcode', 'security code', 'sms code', '验证码', '校验码', '动态码', '认证码', '短信码'];
  var COUNTRY_WORDS = ['country-code', 'country_code', 'country code', 'dial-code', 'dial_code', 'calling code', 'phone-prefix', 'phone_prefix', '区号', '国家码', '国家代码', '国际区号'];

  function isVisible(el) {
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
    var rects = el.getClientRects ? el.getClientRects() : [];
    if (!rects.length) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') !== 0;
  }

  function collectRoots() {
    var roots = [document];
    var cursor = 0;
    while (cursor < roots.length) {
      var root = roots[cursor++];
      var elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var i = 0; i < elements.length; i++) {
        if (elements[i].shadowRoot && roots.indexOf(elements[i].shadowRoot) < 0) roots.push(elements[i].shadowRoot);
      }
    }
    return roots;
  }

  function queryAll(selector) {
    var result = [];
    collectRoots().forEach(function(root) {
      try { result = result.concat(Array.from(root.querySelectorAll(selector))); } catch (_) {}
    });
    return result;
  }

  function associatedText(el) {
    var parts = [
      el.id, el.name, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'),
      el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('role'),
      typeof el.className === 'string' ? el.className : ''
    ];
    if (el.id) {
      collectRoots().some(function(root) {
        try {
          var label = root.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label) { parts.push(label.textContent); return true; }
        } catch (_) {}
        return false;
      });
    }
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(function(id) {
        var labelEl = document.getElementById(id);
        if (labelEl) parts.push(labelEl.textContent);
      });
    }
    var parent = el.closest ? el.closest('label, fieldset, [class*="field"], [class*="form"]') : null;
    if (parent) parts.push((parent.textContent || '').substring(0, 240));
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  function containsAny(text, words) {
    for (var i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) >= 0) return true;
    }
    return false;
  }

  function setNativeValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var own = Object.getOwnPropertyDescriptor(el, 'value');
    var base = Object.getOwnPropertyDescriptor(proto, 'value');
    if (base && base.set && (!own || own.set !== base.set)) base.set.call(el, value);
    else if (own && own.set) own.set.call(el, value);
    else el.value = value;
    if (el._valueTracker) el._valueTracker.setValue('');
  }

  function dispatchValueEvents(el, value) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function fillInput(el, value, overwrite) {
    if (!isVisible(el) || (!overwrite && el.value)) return false;
    el.focus();
    setNativeValue(el, value);
    dispatchValueEvents(el, value);
    return el.value === value;
  }

  function flash(el, color) {
    var oldOutline = el.style.outline;
    var oldOffset = el.style.outlineOffset;
    el.style.outline = '2px solid ' + color;
    el.style.outlineOffset = '2px';
    window.setTimeout(function() {
      el.style.outline = oldOutline;
      el.style.outlineOffset = oldOffset;
    }, 1400);
  }

  function scorePhoneInput(el) {
    var text = associatedText(el);
    if (containsAny(text, CODE_WORDS) || containsAny(text, COUNTRY_WORDS)) return -20;
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    var score = 0;
    if (autocomplete === 'tel' || autocomplete === 'tel-national') score += 12;
    if ((el.type || '').toLowerCase() === 'tel') score += 5;
    if (containsAny(text, PHONE_WORDS)) score += 6;
    var max = Number(el.maxLength || 0);
    if (max >= 7 && max <= 16) score += 2;
    if ((el.inputMode || '').toLowerCase() === 'tel') score += 2;
    return score;
  }

  function findPhoneInput() {
    var best = null;
    var bestScore = 0;
    queryAll('input').forEach(function(el) {
      var type = (el.type || 'text').toLowerCase();
      if (!isVisible(el) || el.value || ['hidden', 'password', 'email', 'url', 'search', 'date', 'time', 'file', 'checkbox', 'radio', 'button', 'submit'].indexOf(type) >= 0) return;
      var score = scorePhoneInput(el);
      if (score > bestScore) { best = el; bestScore = score; }
    });
    return bestScore >= 5 ? best : null;
  }

  function scoreCountryControl(el) {
    var text = associatedText(el);
    var score = containsAny(text, COUNTRY_WORDS) ? 8 : 0;
    if (el.tagName === 'SELECT') {
      var optionText = Array.from(el.options || []).slice(0, 30).map(function(o) { return o.textContent; }).join(' ');
      if (/\+\d{1,4}/.test(optionText)) score += 6;
    }
    return score;
  }

  function optionMatches(option, profile) {
    var text = ((option.textContent || '') + ' ' + (option.value || '')).toLowerCase();
    var digits = profile.countryCode.replace(/\D/g, '');
    return new RegExp('(^|\\D)' + digits + '(\\D|$)').test(text) ||
      (profile.countryIso && new RegExp('(^|\\W)' + profile.countryIso.toLowerCase() + '(\\W|$)').test(text));
  }

  function setCountryControl(profile) {
    var controls = queryAll('select, input').filter(isVisible).sort(function(a, b) {
      return scoreCountryControl(b) - scoreCountryControl(a);
    });
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (scoreCountryControl(control) < 6) break;
      if (control.tagName === 'SELECT') {
        var options = Array.from(control.options || []);
        var option = options.find(function(item) { return optionMatches(item, profile); });
        if (option) {
          control.value = option.value;
          control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          control.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          flash(control, '#2563eb');
          return control;
        }
      } else if (!control.value) {
        if (fillInput(control, profile.countryCode)) {
          flash(control, '#2563eb');
          return control;
        }
      }
    }

    // React/Vue 站点常用自定义 combobox。只点击带明确“国家/区号”语义的控件，
    // 展开后再从 role=option 或常见 option class 中选择目标项。
    var customControls = queryAll('[role="combobox"], button, [class*="country"], [class*="dial-code"]').filter(isVisible);
    customControls.sort(function(a, b) { return scoreCountryControl(b) - scoreCountryControl(a); });
    for (var c = 0; c < customControls.length; c++) {
      var custom = customControls[c];
      if (scoreCountryControl(custom) < 6) break;
      if (optionMatches(custom, profile)) return custom;
      if (custom.dataset.smsAutofillPending === 'true') return custom;
      custom.dataset.smsAutofillPending = 'true';
      try { custom.click(); } catch (_) { continue; }
      window.setTimeout(function(control) {
        var items = queryAll('[role="option"], li, [class*="option"], [class*="menu-item"]').filter(isVisible);
        var match = items.find(function(item) { return optionMatches(item, profile); });
        if (match) {
          try { match.click(); flash(control, '#2563eb'); } catch (_) {}
        }
        delete control.dataset.smsAutofillPending;
      }, 120, custom);
      return custom;
    }
    return null;
  }

  function fillPhone(profile, preferredInput) {
    if (!profile || !profile.nationalNumber) return false;
    var countryControl = setCountryControl(profile);
    var input = preferredInput && preferredInput.tagName === 'INPUT' && isVisible(preferredInput)
      ? preferredInput
      : findPhoneInput();
    if (!input) return !!countryControl;
    var value = profile.nationalNumber;
    var max = Number(input.maxLength || 0);
    if (max > 0 && value.length > max) value = value.substring(0, max);
    if (fillInput(input, value, true)) {
      flash(input, '#2563eb');
      return true;
    }
    return !!countryControl;
  }

  function scoreCodeInput(el) {
    var text = associatedText(el);
    if (containsAny(text, PHONE_WORDS) || containsAny(text, COUNTRY_WORDS)) return -20;
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    var score = 0;
    if (autocomplete === 'one-time-code') score += 15;
    if (containsAny(text, CODE_WORDS)) score += 8;
    var max = Number(el.maxLength || 0);
    if (max >= 4 && max <= 8) score += 3;
    if (['numeric', 'decimal'].indexOf((el.inputMode || '').toLowerCase()) >= 0) score += 1;
    return score;
  }

  function codeInputs() {
    return queryAll('input').filter(function(el) {
      var type = (el.type || 'text').toLowerCase();
      return isVisible(el) && !el.value && ['text', 'tel', 'number', ''].indexOf(type) >= 0;
    });
  }

  function fillSegmentedCode(code, inputs) {
    var singleChar = inputs.filter(function(el) {
      return Number(el.maxLength || 0) === 1 && scoreCodeInput(el) >= 1;
    });
    if (singleChar.length < code.length) return false;
    // 限制在同一表单或紧邻容器，避免跨页面误填多个单字符输入框。
    for (var start = 0; start <= singleChar.length - code.length; start++) {
      var group = singleChar.slice(start, start + code.length);
      var owner = group[0].form || group[0].parentElement;
      if (!group.every(function(el) { return (el.form || el.parentElement) === owner; })) continue;
      var ok = true;
      group.forEach(function(el, index) { if (!fillInput(el, code.charAt(index))) ok = false; });
      if (ok) {
        group.forEach(function(el) { flash(el, '#16a34a'); });
        return true;
      }
    }
    return false;
  }

  function fillCode(code) {
    if (!code) return false;
    var inputs = codeInputs();
    if (fillSegmentedCode(code, inputs)) return true;
    var best = null;
    var bestScore = 0;
    inputs.forEach(function(el) {
      var score = scoreCodeInput(el);
      if (score > bestScore) { best = el; bestScore = score; }
    });
    if (!best || bestScore < 6) return false;
    var max = Number(best.maxLength || 0);
    var value = max > 1 && code.length > max ? code.substring(0, max) : code;
    if (fillInput(best, value)) {
      flash(best, '#16a34a');
      return true;
    }
    return false;
  }

  function attemptFill() {
    if (state.autoFillCode && state.code && Date.now() < state.codeExpiresAt) fillCode(state.code);
  }

  function scheduleAttempt() {
    window.clearTimeout(state.observerTimer);
    state.observerTimer = window.setTimeout(attemptFill, 120);
  }

  document.addEventListener('contextmenu', function(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    lastContextTarget = path.find(function(el) { return el && el.tagName === 'INPUT'; }) || null;
  }, true);

  chrome.runtime.onMessage.addListener(function(message) {
    if (!message) return;
    if (message.type === 'SMS_FILL_PHONE_FROM_CONTEXT_MENU') {
      fillPhone(message.profile, lastContextTarget);
      return;
    }
    if (message.type !== 'SMS_AUTOFILL') return;
    if (message.code) {
      state.code = String(message.code);
      state.codeExpiresAt = Date.now() + 2 * 60 * 1000;
    }
    if (typeof message.autoFillCode === 'boolean') state.autoFillCode = message.autoFillCode;
    scheduleAttempt();
  });

  chrome.runtime.sendMessage({ type: 'GET_SMS_AUTOFILL_CONTEXT' }).then(function(context) {
    if (!context) return;
    state.autoFillCode = context.autoFillCode !== false;
    scheduleAttempt();
  }).catch(function() {});

  var observer = new MutationObserver(scheduleAttempt);
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
})();
