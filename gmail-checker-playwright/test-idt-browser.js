// Identity Toolkit 测试 - 通过浏览器发请求绕过 TLS 指纹检测
// 测试 createAuthUri 端点能否检测 Gmail 邮箱存在性

const { chromium } = require('playwright');

async function main() {
  console.log('=== Identity Toolkit 浏览器测试 ===\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 先打开一个 Google 页面建立 cookie 上下文
  await page.goto('https://accounts.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1000);

  // 从页面提取 Google 自己的 API Key（如果有的话）
  const pageKeys = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const keys = [];
    const matches = html.matchAll(/AIzaSy[A-Za-z0-9_-]{33}/g);
    for (const m of matches) keys.push(m[0]);
    return [...new Set(keys)];
  });
  console.log(`页面中找到的 API Keys: ${pageKeys.length}`);
  pageKeys.forEach(k => console.log(`  ${k}`));

  // 测试用的 Key 列表
  const testKeys = [
    ...pageKeys,
    'AIzaSyB6ZODYFbBPqLFm-hlMZjm7Z3Btmlk-axo',
    'AIzaSyAa8yy0GdcGPHdtD083HiGGx_S0vMPScDM',
  ];

  const testEmails = [
    { email: '000001@gmail.com', expect: 'exists' },
    { email: '999999@gmail.com', expect: 'exists' },
    { email: 'dhjfkjshfk234hjkdhkh@gmail.com', expect: 'not exists' },
    { email: 'qkbzh3240@gmail.com', expect: 'not exists (random)' },
  ];

  // 方法 1: createAuthUri（通过浏览器 fetch）
  console.log('\n--- 方法 1: createAuthUri ---');
  for (const key of testKeys.slice(0, 3)) {
    console.log(`\nKey: ${key.substring(0, 25)}...`);
    for (const { email, expect } of testEmails) {
      try {
        const result = await page.evaluate(async ({ email, key }) => {
          try {
            const resp = await fetch(
              `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: email, continueUri: 'http://localhost' }),
              }
            );
            const text = await resp.text();
            return { status: resp.status, body: text.substring(0, 500) };
          } catch (e) {
            return { status: 'error', body: e.message };
          }
        }, { email, key });
        
        const registered = result.body.includes('"registered"');
        const regValue = result.body.match(/"registered"\s*:\s*(true|false)/)?.[1] || '?';
        console.log(`  [${email}] ${result.status} | registered=${regValue} | expect=${expect}`);
        if (result.status !== 200) console.log(`    ${result.body.substring(0, 200)}`);
      } catch (e) {
        console.log(`  [${email}] Error: ${e.message.substring(0, 80)}`);
      }
    }
  }

  // 方法 2: 从 Google 登录页面提取内部使用的 API Key
  console.log('\n--- 方法 2: 从登录页提取 Key ---');
  await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  
  const loginPageKeys = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent);
    const allText = html + scripts.join('');
    const keys = [];
    const matches = allText.matchAll(/AIzaSy[A-Za-z0-9_-]{33}/g);
    for (const m of matches) keys.push(m[0]);
    // 也找 key= 参数
    const urlMatches = allText.matchAll(/key=([A-Za-z0-9_-]{39})/g);
    for (const m of urlMatches) keys.push(m[1]);
    return [...new Set(keys)];
  });
  console.log(`登录页 API Keys: ${loginPageKeys.length}`);
  loginPageKeys.forEach(k => console.log(`  ${k}`));

  // 方法 3: 尝试 Google 内部的 identitytoolkit 端点（不需要 key）
  console.log('\n--- 方法 3: 内部端点（无 key）---');
  const internalEndpoints = [
    'https://www.googleapis.com/identitytoolkit/v3/relyingparty/createAuthUri',
    'https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri',
  ];
  
  for (const endpoint of internalEndpoints) {
    try {
      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              identifier: '000001@gmail.com', 
              continueUri: 'https://accounts.google.com' 
            }),
          });
          return { status: resp.status, body: (await resp.text()).substring(0, 500) };
        } catch (e) {
          return { status: 'error', body: e.message };
        }
      }, endpoint);
      console.log(`  ${endpoint.split('/').pop()}: ${result.status}`);
      console.log(`    ${result.body.substring(0, 200)}`);
    } catch (e) {
      console.log(`  Error: ${e.message.substring(0, 80)}`);
    }
  }

  // 方法 4: 尝试注册页面的 API Key
  console.log('\n--- 方法 4: 注册页 Key ---');
  await page.goto('https://accounts.google.com/signup', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  
  const signupKeys = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const keys = [];
    const matches = html.matchAll(/AIzaSy[A-Za-z0-9_-]{33}/g);
    for (const m of matches) keys.push(m[0]);
    return [...new Set(keys)];
  });
  console.log(`注册页 API Keys: ${signupKeys.length}`);
  signupKeys.forEach(k => console.log(`  ${k}`));

  // 如果找到了新 key，测试它们
  const allNewKeys = [...new Set([...loginPageKeys, ...signupKeys])].filter(k => !testKeys.includes(k));
  if (allNewKeys.length > 0) {
    console.log(`\n--- 测试新发现的 ${allNewKeys.length} 个 Key ---`);
    for (const key of allNewKeys) {
      console.log(`\nKey: ${key}`);
      for (const { email, expect } of testEmails.slice(0, 2)) {
        try {
          const result = await page.evaluate(async ({ email, key }) => {
            const resp = await fetch(
              `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: email, continueUri: 'http://localhost' }),
              }
            );
            return { status: resp.status, body: (await resp.text()).substring(0, 500) };
          }, { email, key });
          const regValue = result.body.match(/"registered"\s*:\s*(true|false)/)?.[1] || '?';
          console.log(`  [${email}] ${result.status} | registered=${regValue}`);
          if (result.status !== 200) console.log(`    ${result.body.substring(0, 200)}`);
        } catch (e) {
          console.log(`  Error: ${e.message.substring(0, 80)}`);
        }
      }
    }
  }

  await browser.close();
  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
