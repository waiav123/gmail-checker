// 测试 Identity Toolkit - 从 about:blank 发请求（无 referer 限制）
// 同时测试 disify 等第三方 API 的实际用户检测能力
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 从 about:blank 发请求，避免 referer 限制
  await page.goto('about:blank');
  await page.waitForTimeout(500);

  console.log('=== 1. Identity Toolkit 从 about:blank 测试 ===\n');

  // 用第二个 key（之前因 referer 被拒）
  const key = 'AIzaSyAa8yy0GdcGPHdtD083HiGGx_S0vMPScDM';
  const idtResult = await page.evaluate(async (key) => {
    const results = {};
    const tests = [
      { name: 'createAuthUri-exist', body: { identifier: 'test@gmail.com', continueUri: 'http://localhost' } },
      { name: 'createAuthUri-noexist', body: { identifier: 'dhjfkjshfk234hjkdhkh@gmail.com', continueUri: 'http://localhost' } },
      { name: 'createAuthUri-000001', body: { identifier: '000001@gmail.com', continueUri: 'http://localhost' } },
    ];
    for (const t of tests) {
      try {
        const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t.body)
        });
        results[t.name] = { status: r.status, body: await r.text() };
      } catch (e) {
        results[t.name] = { error: e.message };
      }
    }
    return results;
  }, key);

  for (const [name, res] of Object.entries(idtResult)) {
    if (res.error) {
      console.log(`❌ [${name}] Error: ${res.error}`);
    } else {
      console.log(`🔬 [${name}] HTTP ${res.status}`);
      console.log(`   ${res.body.substring(0, 300)}`);
    }
  }

  console.log('\n=== 2. 第三方 API 深入测试 ===\n');

  const thirdPartyResult = await page.evaluate(async () => {
    const results = {};
    // disify - 测试是否能区分存在/不存在
    const disifyTests = [
      { name: 'disify-exist', url: 'https://disify.com/api/email/test@gmail.com' },
      { name: 'disify-noexist', url: 'https://disify.com/api/email/dhjfkjshfk234hjkdhkh@gmail.com' },
      { name: 'disify-000001', url: 'https://disify.com/api/email/000001@gmail.com' },
    ];
    for (const t of disifyTests) {
      try {
        const r = await fetch(t.url);
        results[t.name] = { status: r.status, body: await r.text() };
      } catch (e) {
        results[t.name] = { error: e.message };
      }
    }

    // emailrep.io
    try {
      const r = await fetch('https://emailrep.io/test@gmail.com', { headers: { 'Accept': 'application/json' } });
      results['emailrep'] = { status: r.status, body: (await r.text()).substring(0, 300) };
    } catch (e) {
      results['emailrep'] = { error: e.message };
    }

    // eva.pingutil.com (免费邮箱验证)
    try {
      const r = await fetch('https://api.eva.pingutil.com/email?email=test@gmail.com');
      results['eva-exist'] = { status: r.status, body: (await r.text()).substring(0, 300) };
    } catch (e) {
      results['eva-exist'] = { error: e.message };
    }
    try {
      const r = await fetch('https://api.eva.pingutil.com/email?email=dhjfkjshfk234hjkdhkh@gmail.com');
      results['eva-noexist'] = { status: r.status, body: (await r.text()).substring(0, 300) };
    } catch (e) {
      results['eva-noexist'] = { error: e.message };
    }

    return results;
  });

  for (const [name, res] of Object.entries(thirdPartyResult)) {
    if (res.error) {
      console.log(`❌ [${name}] Error: ${res.error}`);
    } else {
      console.log(`🔬 [${name}] HTTP ${res.status}`);
      console.log(`   ${res.body.substring(0, 200)}`);
    }
  }

  console.log('\n=== 3. 忘记密码流程 API 化测试 ===\n');

  // 走忘记密码流程，抓包
  const recoveryCaps = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      recoveryCaps.push({ url: req.url(), postData: req.postData() });
    }
  });
  page.on('response', async res => {
    if (res.request().method() === 'POST' && res.url().includes('batchexecute')) {
      const entry = recoveryCaps.find(e => e.url === res.url() && !e.responseBody);
      if (entry) { entry.responseBody = await res.text().catch(() => ''); entry.status = res.status(); }
    }
  });

  try {
    await page.goto('https://accounts.google.com/signin/recovery', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const input = page.locator('input[type="email"], input[type="text"]').first();
    if (await input.count() > 0) {
      recoveryCaps.length = 0;
      await input.fill('dhjfkjshfk234hjkdhkh@gmail.com');
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(5000);

      console.log(`Recovery 请求数: ${recoveryCaps.length}`);
      for (const cap of recoveryCaps) {
        console.log(`  URL: ${cap.url.substring(0, 100)}`);
        console.log(`  PostData: ${(cap.postData || '').substring(0, 200)}`);
        console.log(`  Status: ${cap.status}`);
        console.log(`  Response: ${(cap.responseBody || '').substring(0, 300)}`);
        // 提取 RPC 名称
        const rpcMatch = cap.url.match(/rpcids=([^&]+)/);
        if (rpcMatch) console.log(`  RPC: ${rpcMatch[1]}`);
      }
    }
  } catch (e) {
    console.log(`Recovery error: ${e.message.substring(0, 80)}`);
  }

  await browser.close();
  console.log('\n🏁 完成');
}

main().catch(console.error);
