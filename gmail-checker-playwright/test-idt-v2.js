// Identity Toolkit v2 - 从空白页发请求避免 referer 限制
const { chromium } = require('playwright');

async function testWithKey(page, key, emails) {
  console.log(`\nKey: ${key.substring(0, 30)}...`);
  for (const email of emails) {
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
        return { status: resp.status, body: await resp.text() };
      }, { email, key });
      
      const reg = result.body.match(/"registered"\s*:\s*(true|false)/)?.[1];
      const kind = result.body.match(/"kind"\s*:\s*"([^"]+)"/)?.[1];
      console.log(`  [${email}] ${result.status} | registered=${reg || '?'} | kind=${kind || '?'}`);
      if (result.status !== 200) console.log(`    ${result.body.substring(0, 150)}`);
    } catch (e) {
      console.log(`  [${email}] Error: ${e.message.substring(0, 80)}`);
    }
  }
}

async function main() {
  console.log('=== Identity Toolkit v2 测试 ===\n');

  const browser = await chromium.launch({ headless: true });
  
  // 用空白页避免 referer 限制
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('about:blank');

  const emails = [
    '000001@gmail.com',
    '999999@gmail.com', 
    'dhjfkjshfk234hjkdhkh@gmail.com',
    'qkbzh3240@gmail.com',
  ];

  // 测试已知的公开 key
  const keys = [
    'AIzaSyAa8yy0GdcGPHdtD083HiGGx_S0vMPScDM',
    'AIzaSyB6ZODYFbBPqLFm-hlMZjm7Z3Btmlk-axo',
    // Chrome 浏览器内置的 key
    'AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
    // YouTube 的 key
    'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    // Google Cloud Console 的 key
    'AIzaSyCI-zsRP85UVOi0DjtiCwWBwQ1djDy741g',
  ];

  for (const key of keys) {
    await testWithKey(page, key, emails);
  }

  // 方法 2: 尝试 v3 旧版端点
  console.log('\n--- v3 旧版端点 ---');
  for (const key of keys.slice(0, 2)) {
    console.log(`\nKey: ${key.substring(0, 25)}...`);
    try {
      const result = await page.evaluate(async ({ key }) => {
        const resp = await fetch(
          `https://www.googleapis.com/identitytoolkit/v3/relyingparty/createAuthUri?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              identifier: '000001@gmail.com', 
              continueUri: 'http://localhost' 
            }),
          }
        );
        return { status: resp.status, body: await resp.text() };
      }, { key });
      console.log(`  Status: ${result.status}`);
      console.log(`  ${result.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message.substring(0, 80)}`);
    }
  }

  // 方法 3: 尝试 sendVerificationCode（手机号验证端点）
  console.log('\n--- accounts:signInWithPassword ---');
  for (const key of keys.slice(0, 2)) {
    console.log(`\nKey: ${key.substring(0, 25)}...`);
    for (const email of emails.slice(0, 2)) {
      try {
        const result = await page.evaluate(async ({ email, key }) => {
          const resp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password: 'x', returnSecureToken: true }),
            }
          );
          return { status: resp.status, body: await resp.text() };
        }, { email, key });
        const errMsg = result.body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || '';
        console.log(`  [${email}] ${result.status} | ${errMsg.substring(0, 80)}`);
      } catch (e) {
        console.log(`  Error: ${e.message.substring(0, 80)}`);
      }
    }
  }

  await browser.close();
  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
