const fs = require('fs');
const path = require('path');

globalThis.self = globalThis;
eval(fs.readFileSync(path.join(__dirname, '..', 'shared', 'smsutil.js'), 'utf8'));

const now = Date.UTC(2026, 6, 28, 12, 0, 0);
const promo = '【积分提醒】截至本月12日，您有1900积分。请点击 m.10010.cn/qAZRw?u=63cc0a340b0f488d';
const tests = [
  ['服务端 ID 优先且稳定', SharedSmsUtil.getSmsKey({ id: 42, date: now, content: promo }), 'id:42'],
  ['数字与字符串时间生成同一键',
    SharedSmsUtil.getSmsKey({ number: '10010', date: String(now), content: promo }),
    SharedSmsUtil.getSmsKey({ number: '10010', timestamp: now, content: promo })],
  ['五分钟前的积分短信不通知', SharedSmsUtil.isRecentSms({ date: now - 6 * 60 * 1000 }, now), false],
  ['刚收到的验证码短信允许通知', SharedSmsUtil.isRecentSms({ date: now - 5000 }, now), true],
  ['秒级时间戳可以识别', SharedSmsUtil.isRecentSms({ date: Math.floor((now - 5000) / 1000) }, now), true]
];

let failures = 0;
for (const [name, actual, expected] of tests) {
  const pass = actual === expected;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass) {
    failures++;
    console.log('  expected:', expected, 'actual:', actual);
  }
}
process.exit(failures ? 1 : 0);
