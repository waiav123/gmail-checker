// 测试 signInWithPassword - 用错误密码区分存在/不存在
const { chromium } = require('playwright');
const API_KEY = 'AIzaSyBEhf6doZHWosZyPat-qBFZmWSwck_KWMs';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const emails = [
    '000001@gmail.com',
    '999999@gmail.com',
    'dhjfkjshfk234hjkdhkh@gmail.com',
    'qkbzh3240@gmail.com',
    'test@gmail.com',
  ];

  // 方法 1: signInWithPassword
  console.log('--- signInWithPassword ---');
  for (const email of emails) {
    const r = await page.evaluate(async ({ email, key }) => {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'x', returnSecureToken: true }) }
      );
      return { status: resp.status, body: await resp.text() };
    }, { email, key: API_KEY });
    const msg = r.body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || '';
    console.log(`  [${email.padEnd(40)}] ${r.status} | ${msg}`);
  }

  // 方法 2: signInWithEmailLink (sendOobCode)
  console.log('\n--- sendOobCode (email link) ---');
  for (const email of emails.slice(0, 3)) {
    const r = await page.evaluate(async ({ email, key }) => {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }) }
      );
      return { status: resp.status, body: await resp.text() };
    }, { email, key: API_KEY });
    const msg = r.body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || '';
    console.log(`  [${email.padEnd(40)}] ${r.status} | ${msg}`);
  }

  // 方法 3: signUp (尝试注册已存在的邮箱)
  console.log('\n--- signUp ---');
  for (const email of emails.slice(0, 3)) {
    const r = await page.evaluate(async ({ email, key }) => {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'TestPass123!' }) }
      );
      return { status: resp.status, body: await resp.text() };
    }, { email, key: API_KEY });
    const msg = r.body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || '';
    console.log(`  [${email.padEnd(40)}] ${r.status} | ${msg}`);
  }

  await browser.close();
}

main().catch(console.error);
