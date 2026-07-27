(function() {
  const g = typeof window !== 'undefined' ? window : self;

  function getSmsKey(sms) {
    const idVal = sms && (sms.id ?? sms._id ?? sms.sms_id ?? sms.smsId);
    if (idVal !== undefined && idVal !== null && String(idVal) !== '') {
      return `id:${String(idVal)}`;
    }
    const numberVal = sms && sms.number != null ? String(sms.number) : '';
    const tsRaw = (sms && (sms.timestamp ?? sms.date ?? sms.time)) ?? 0;
    const tsVal = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw) || 0;
    const contentVal = sms && sms.content != null ? String(sms.content) : '';
    return `${numberVal}|${tsVal}|${contentVal}`;
  }

  function toTimestamp(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    let timestamp = Number(raw);
    if (!Number.isFinite(timestamp)) timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return null;
    if (timestamp > 0 && timestamp < 100000000000) timestamp *= 1000;
    return timestamp;
  }

  function isRecentSms(sms, now, maxAgeMs) {
    const timestamp = toTimestamp(sms && (sms.timestamp ?? sms.date ?? sms.time));
    if (timestamp === null) return true;
    const current = typeof now === 'number' ? now : Date.now();
    const maxAge = typeof maxAgeMs === 'number' ? maxAgeMs : 5 * 60 * 1000;
    return Math.abs(current - timestamp) <= maxAge;
  }

  g.SharedSmsUtil = { getSmsKey, toTimestamp, isRecentSms };
})();
