// Node.js test for shared/codeutil.js extraction logic
const fs = require('fs');
const path = require('path');

// codeutil.js uses `self` (Web Worker global) — provide a shim for Node.js
globalThis.self = globalThis;
const code = fs.readFileSync(path.join(__dirname, '..', 'shared', 'codeutil.js'), 'utf8');
eval(code.replace('var SharedCodeUtil', 'globalThis.SharedCodeUtil'));

const testCases = [
  { text: '【淘宝】您的验证码为385291，请勿泄露', expected: '385291' },
  { text: '验证码：123456，5分钟内有效', expected: '123456' },
  { text: '您的校验码是 886234，请于10分钟内输入', expected: '886234' },
  { text: '【支付宝】385291是你的验证码', expected: '385291' },
  { text: 'Your verification code is 456789', expected: '456789' },
  { text: 'Your one-time password: 1234', expected: '1234' },
  { text: 'OTP: 998877', expected: '998877' },
  { text: '【工商银行】您尾号6688的卡，动态码 258369', expected: '258369' },
  { text: '【京东】验证码 552014，请在30分钟内使用', expected: '552014' },
  { text: '您的安全码为：4321', expected: '4321' },
  { text: '【微信】您的验证码为123456，请勿告诉他人。如非本人操作，请忽略本短信', expected: '123456' },
  { text: '尊敬的客户，您的取件码是 6789，请凭此码取件', expected: '6789' },
  { text: 'Your code: 777888', expected: '777888' },
  { text: '【建行】尊敬的客户，您于2024年1月15日的交易验证码为369258', expected: '369258' },
  { text: '【10086】您的验证码是8412，请不要泄露给他人', expected: '8412' },
  { text: '【美团】验证码：654321，请尽快输入', expected: '654321' },
  { text: '您的验证码 246810，有效期15分钟', expected: '246810' },
  { text: '【拼多多】你的验证码:135790,请勿泄露', expected: '135790' },
  { text: 'Verification code for your account: 864209', expected: '864209' },
  { text: 'PIN: 0000', expected: '0000' },
];

let passCount = 0;
let failCount = 0;
const failures = [];

testCases.forEach((tc, idx) => {
  const result = SharedCodeUtil.extractVerificationCode(tc.text);
  const pass = result === tc.expected;
  if (pass) {
    passCount++;
    console.log(`  PASS [${idx + 1}] "${tc.text.substring(0, 40)}..." -> ${result}`);
  } else {
    failCount++;
    failures.push({ idx: idx + 1, text: tc.text, expected: tc.expected, got: result });
    console.log(`  FAIL [${idx + 1}] "${tc.text.substring(0, 40)}..." -> got="${result}" expected="${tc.expected}"`);
  }
});

console.log(`\n========== Result ==========`);
console.log(`Pass: ${passCount}/${testCases.length}`);
console.log(`Fail: ${failCount}/${testCases.length}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => {
    console.log(`  #${f.idx}: text="${f.text}" expected="${f.expected}" got="${f.got}"`);
  });
}
process.exit(failCount > 0 ? 1 : 0);
