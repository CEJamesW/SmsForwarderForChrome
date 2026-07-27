const fs = require('fs');
const path = require('path');

globalThis.self = globalThis;
eval(fs.readFileSync(path.join(__dirname, '..', 'shared', 'phoneutil.js'), 'utf8'));

const config = {
  sim_info_list: {
    value: {
      0: { number: '138 1234 5678', country_iso: 'cn', sim_slot_index: 0, subscription_id: 11 },
      1: { number: '+44 7700 900123', country_iso: 'gb', sim_slot_index: 1, subscription_id: 22 }
    }
  }
};

const cases = [
  {
    name: 'country_iso 转 +86 并按 sim_id 选卡',
    actual: () => SharedPhoneUtil.resolvePhoneProfile({ sim_id: 0 }, config, '', '+86'),
    expected: { countryCode: '+86', nationalNumber: '13812345678', e164: '+8613812345678', source: 'sim', simSlot: 0 }
  },
  {
    name: '国际号码自身识别 +44',
    actual: () => SharedPhoneUtil.resolvePhoneProfile({ sub_id: 22 }, config, '', '+86'),
    expected: { countryCode: '+44', nationalNumber: '7700900123', e164: '+447700900123', source: 'sim', simSlot: 1 }
  },
  {
    name: 'SIM 缺失时使用手工备用',
    actual: () => SharedPhoneUtil.resolvePhoneProfile(null, {}, '+8613912345678', '+86'),
    expected: { countryCode: '+86', nationalNumber: '13912345678', e164: '+8613912345678', source: 'manual' }
  },
  {
    name: '双卡且无卡槽时不猜号码',
    actual: () => SharedPhoneUtil.resolvePhoneProfile({}, config, '', '+86'),
    expected: null
  },
  {
    name: '00 国际前缀',
    actual: () => SharedPhoneUtil.splitInternationalNumber('0086 13712345678', '', ''),
    expected: { countryCode: '+86', nationalNumber: '13712345678', e164: '+8613712345678' }
  }
];

let failures = 0;
for (const tc of cases) {
  const actual = tc.actual();
  const picked = actual && Object.fromEntries(Object.keys(tc.expected || {}).map(key => [key, actual[key]]));
  const pass = JSON.stringify(picked) === JSON.stringify(tc.expected);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${tc.name}`);
  if (!pass) {
    failures++;
    console.log('  expected:', tc.expected);
    console.log('  actual:  ', actual);
  }
}

process.exit(failures ? 1 : 0);
