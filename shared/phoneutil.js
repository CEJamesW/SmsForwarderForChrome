(function() {
  const g = typeof window !== 'undefined' ? window : self;

  // SmsForwarder 的 SIM 信息提供 country_iso，但不提供国际区号。
  // 这里覆盖常见国家/地区；未知 ISO 时仍可从 + 开头的号码中解析区号。
  const ISO_TO_CALLING_CODE = {
    ad: '+376', ae: '+971', af: '+93', ag: '+1', ai: '+1', al: '+355', am: '+374', ao: '+244', ar: '+54',
    as: '+1', at: '+43', au: '+61', aw: '+297', ax: '+358', az: '+994', ba: '+387', bb: '+1', bd: '+880',
    be: '+32', bf: '+226', bg: '+359', bh: '+973', bi: '+257', bj: '+229', bl: '+590', bm: '+1', bn: '+673',
    bo: '+591', bq: '+599', br: '+55', bs: '+1', bt: '+975', bw: '+267', by: '+375', bz: '+501', ca: '+1',
    cc: '+61', cd: '+243', cf: '+236', cg: '+242', ch: '+41', ci: '+225', ck: '+682', cl: '+56', cm: '+237',
    cn: '+86', co: '+57', cr: '+506', cu: '+53', cv: '+238', cw: '+599', cx: '+61', cy: '+357', cz: '+420',
    de: '+49', dj: '+253', dk: '+45', dm: '+1', do: '+1', dz: '+213', ec: '+593', ee: '+372', eg: '+20',
    eh: '+212', er: '+291', es: '+34', et: '+251', fi: '+358', fj: '+679', fk: '+500', fm: '+691', fo: '+298',
    fr: '+33', ga: '+241', gb: '+44', gd: '+1', ge: '+995', gf: '+594', gg: '+44', gh: '+233', gi: '+350',
    gl: '+299', gm: '+220', gn: '+224', gp: '+590', gq: '+240', gr: '+30', gt: '+502', gu: '+1', gw: '+245',
    gy: '+592', hk: '+852', hn: '+504', hr: '+385', ht: '+509', hu: '+36', id: '+62', ie: '+353', il: '+972',
    im: '+44', in: '+91', io: '+246', iq: '+964', ir: '+98', is: '+354', it: '+39', je: '+44', jm: '+1',
    jo: '+962', jp: '+81', ke: '+254', kg: '+996', kh: '+855', ki: '+686', km: '+269', kn: '+1', kp: '+850',
    kr: '+82', kw: '+965', ky: '+1', kz: '+7', la: '+856', lb: '+961', lc: '+1', li: '+423', lk: '+94',
    lr: '+231', ls: '+266', lt: '+370', lu: '+352', lv: '+371', ly: '+218', ma: '+212', mc: '+377', md: '+373',
    me: '+382', mf: '+590', mg: '+261', mh: '+692', mk: '+389', ml: '+223', mm: '+95', mn: '+976', mo: '+853',
    mp: '+1', mq: '+596', mr: '+222', ms: '+1', mt: '+356', mu: '+230', mv: '+960', mw: '+265', mx: '+52',
    my: '+60', mz: '+258', na: '+264', nc: '+687', ne: '+227', nf: '+672', ng: '+234', ni: '+505', nl: '+31',
    no: '+47', np: '+977', nr: '+674', nu: '+683', nz: '+64', om: '+968', pa: '+507', pe: '+51', pf: '+689',
    pg: '+675', ph: '+63', pk: '+92', pl: '+48', pm: '+508', pr: '+1', ps: '+970', pt: '+351', pw: '+680',
    py: '+595', qa: '+974', re: '+262', ro: '+40', rs: '+381', ru: '+7', rw: '+250', sa: '+966', sb: '+677',
    sc: '+248', sd: '+249', se: '+46', sg: '+65', sh: '+290', si: '+386', sj: '+47', sk: '+421', sl: '+232',
    sm: '+378', sn: '+221', so: '+252', sr: '+597', ss: '+211', st: '+239', sv: '+503', sx: '+1', sy: '+963',
    sz: '+268', tc: '+1', td: '+235', tg: '+228', th: '+66', tj: '+992', tk: '+690', tl: '+670', tm: '+993',
    tn: '+216', to: '+676', tr: '+90', tt: '+1', tv: '+688', tw: '+886', tz: '+255', ua: '+380',
    ug: '+256', us: '+1', uy: '+598', uz: '+998', va: '+39', vc: '+1', ve: '+58', vg: '+1', vi: '+1',
    vn: '+84', vu: '+678', wf: '+681', ws: '+685', xk: '+383', ye: '+967', yt: '+262', za: '+27',
    zm: '+260', zw: '+263'
  };

  const CALLING_CODES = Array.from(new Set(Object.values(ISO_TO_CALLING_CODE)))
    .sort((a, b) => b.length - a.length);

  function normalizeCountryCode(value) {
    if (value == null) return '';
    var digits = String(value).replace(/\D/g, '');
    return digits ? '+' + digits : '';
  }

  function callingCodeForIso(countryIso) {
    if (!countryIso) return '';
    return ISO_TO_CALLING_CODE[String(countryIso).trim().toLowerCase()] || '';
  }

  function splitInternationalNumber(rawNumber, countryIso, fallbackCountryCode) {
    if (rawNumber == null) return null;
    var raw = String(rawNumber).trim();
    if (!raw) return null;

    // Android 有时返回带空格、括号或 00 国际前缀的号码。
    var compact = raw.replace(/[\s().-]/g, '');
    if (compact.indexOf('00') === 0) compact = '+' + compact.substring(2);
    var digits = compact.replace(/\D/g, '');
    if (digits.length < 5 || digits.length > 18) return null;

    var countryCode = '';
    var nationalNumber = digits;
    if (compact.charAt(0) === '+') {
      var e164 = '+' + digits;
      for (var i = 0; i < CALLING_CODES.length; i++) {
        if (e164.indexOf(CALLING_CODES[i]) === 0) {
          countryCode = CALLING_CODES[i];
          nationalNumber = digits.substring(countryCode.length - 1);
          break;
        }
      }
    }

    if (!countryCode) {
      countryCode = callingCodeForIso(countryIso) || normalizeCountryCode(fallbackCountryCode);
      var ccDigits = countryCode.replace(/\D/g, '');
      // 国内 API 偶尔返回 8613812345678 但没有加号。
      if (ccDigits && digits.indexOf(ccDigits) === 0 && digits.length - ccDigits.length >= 5) {
        nationalNumber = digits.substring(ccDigits.length);
      }
    }

    if (!countryCode || nationalNumber.length < 5) return null;
    return {
      countryCode: countryCode,
      nationalNumber: nationalNumber,
      e164: countryCode + nationalNumber,
      countryIso: countryIso ? String(countryIso).trim().toLowerCase() : '',
      sourceNumber: raw
    };
  }

  function unwrapConfigValue(value) {
    return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
      ? value.value
      : value;
  }

  function getSimInfoList(apiConfigData) {
    if (!apiConfigData || typeof apiConfigData !== 'object') return [];
    var rawList = unwrapConfigValue(apiConfigData.sim_info_list || apiConfigData.simInfoList);
    if (!rawList || typeof rawList !== 'object') return [];
    return Object.keys(rawList).map(function(key) {
      var sim = rawList[key];
      if (!sim || typeof sim !== 'object') return null;
      return { key: String(key), sim: sim };
    }).filter(Boolean);
  }

  function firstDefined(obj, keys) {
    if (!obj) return undefined;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return undefined;
  }

  function resolvePhoneProfile(sms, apiConfigData, fallbackNumber, fallbackCountryCode) {
    var entries = getSimInfoList(apiConfigData);
    var smsSlot = firstDefined(sms, ['sim_id', 'simId', 'sim_slot_index', 'simSlotIndex', 'sim_slot', 'simSlot']);
    var smsSubId = firstDefined(sms, ['sub_id', 'subId', 'subscription_id', 'subscriptionId']);
    var selected = null;

    if (smsSlot !== undefined && Number(smsSlot) >= 0) {
      selected = entries.find(function(entry) {
        var slot = firstDefined(entry.sim, ['sim_slot_index', 'simSlotIndex']);
        return String(entry.key) === String(smsSlot) || (slot !== undefined && Number(slot) === Number(smsSlot));
      }) || null;
    }
    if (!selected && smsSubId !== undefined) {
      selected = entries.find(function(entry) {
        var subId = firstDefined(entry.sim, ['subscription_id', 'subscriptionId']);
        return subId !== undefined && Number(subId) === Number(smsSubId);
      }) || null;
    }
    // 只有一张可用 SIM 时无需猜卡槽；双卡但短信无卡槽信息时使用手工兜底。
    if (!selected && entries.length === 1) selected = entries[0];

    if (selected) {
      var simNumber = firstDefined(selected.sim, ['number', 'phone_number', 'phoneNumber']);
      var countryIso = firstDefined(selected.sim, ['country_iso', 'countryIso']);
      var detected = splitInternationalNumber(simNumber, countryIso, fallbackCountryCode);
      if (detected) {
        detected.source = 'sim';
        detected.simSlot = Number(firstDefined(selected.sim, ['sim_slot_index', 'simSlotIndex']) ?? selected.key);
        return detected;
      }
    }

    var fallback = splitInternationalNumber(fallbackNumber, '', fallbackCountryCode);
    if (fallback) fallback.source = 'manual';
    return fallback;
  }

  g.SharedPhoneUtil = {
    ISO_TO_CALLING_CODE: ISO_TO_CALLING_CODE,
    normalizeCountryCode: normalizeCountryCode,
    callingCodeForIso: callingCodeForIso,
    splitInternationalNumber: splitInternationalNumber,
    getSimInfoList: getSimInfoList,
    resolvePhoneProfile: resolvePhoneProfile
  };
})();
