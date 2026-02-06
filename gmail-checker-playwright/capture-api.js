// API 抓包工具 - 全自动版
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CAPTURE_FILE = path.join(__dirname, 'captured-requests.json');
const captured = [];

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // 拦截 POST 请求
  page.on('request', req => {
    const url = req.url();
    if (req.method() === 'POST' && url.includes('accounts.google.com')) {
      captured.push({
        ts: new Date().toISOString(),
        url, postData: req.postData(),
        headers: Object.fromEntries(
          Object.entries(req.headers()).filter(([k]) =>
            ['content-type','cookie','x-same-domain','google-accounts-xsrf','origin','referer']
              .some(h => k.toLowerCase().includes(h)))
        )
      });
      console.log(`POST ${url.substring(0, 120)}`);
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (res.request().method() === 'POST' && url.includes('accounts.google.com')) {
      try {
        const body = await res.text().catch(() => '');
        const entry = captured.find(e => e.url === url && !e.status);
        if (entry) { entry.status = res.status(); entry.body = body.substring(0, 3000); }
      } catch {}
    }
  });

  console.log('\n=== Step 1: 打开注册页 ===');
  await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('=== Step 2: 填名字 ===');
  try {
    const ni = page.locator('input[type="text"]:visible');
    if (await ni.count() >= 2) { await ni.nth(0).fill('Test'); await ni.nth(1).fill('User'); }
    else if (await ni.count() >= 1) { await ni.nth(0).fill('Test'); }
    await page.waitForTimeout(500);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
    console.log('  OK');
  } catch (e) { console.log('  FAIL:', e.message.substring(0, 50)); }

  console.log('=== Step 3: 填生日 ===');
  try {
    await page.waitForSelector('input', { timeout: 10000 });
    await page.locator('input').first().fill('1990');
    await page.waitForTimeout(300);
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(500);
    await page.locator('[role="listbox"]:visible [role="option"]').first().click();
    await page.waitForTimeout(500);
    await page.locator('input').nth(1).fill('15');
    await page.waitForTimeout(300);
    await page.locator('[role="combobox"]').nth(1).click();
    await page.waitForTimeout(500);
    await page.locator('[role="listbox"]:visible [role="option"]').nth(1).click();
    await page.waitForTimeout(500);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
    console.log('  OK');
  } catch (e) { console.log('  FAIL:', e.message.substring(0, 50)); }

  console.log('=== Step 4: 用户名页面 ===');
  await page.waitForTimeout(2000);
  try {
    const radios = page.locator('[role="radio"], input[type="radio"]');
    if (await radios.count() > 0) {
      await radios.nth((await radios.count()) - 1).click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  console.log('=== Step 5: 测试用户名 ===');
  const tests = [
    { name: 'dhjfkjshfk234hjkdhkh', expect: 'available' },
    { name: 'test', expect: 'taken' },
    { name: 'xyzrandom99887766abc', expect: 'available' },
  ];

  for (const tc of tests) {
    console.log(`\n--- 测试: ${tc.name} (预期: ${tc.expect}) ---`);
    const before = captured.length;
    try {
      const input = page.locator('input[type="text"]:visible').first();
      if (await input.count() === 0) { console.log('  找不到输入框'); continue; }
      await input.fill('');
      await page.waitForTimeout(100);
      await input.fill(tc.name);
      await page.waitForTimeout(300);
      const bUrl = page.url();
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(400);
        if (page.url() !== bUrl) break;
        const t = await page.locator('main').innerText().catch(() => '');
        if (t.includes('已有人使用') || t.includes('is taken') || t.includes('不允许') || t.includes('not allowed')) break;
      }
      const rUrl = page.url();
      const rTxt = await page.locator('main').innerText().catch(() => '');
      if (rUrl.includes('/password')) {
        console.log('  结果: AVAILABLE');
        await page.goBack();
        await page.waitForTimeout(2000);
        try { const r = page.locator('[role="radio"]'); if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(800); } } catch {}
      } else if (rTxt.includes('已有人使用') || rTxt.includes('is taken')) {
        console.log('  结果: TAKEN');
      } else { console.log('  结果: OTHER'); }
      const newReqs = captured.slice(before);
      console.log(`  新增请求: ${newReqs.length}`);
      for (const r of newReqs) console.log(`    ${r.url.substring(0, 100)}`);
    } catch (e) { console.log(`  ERROR: ${e.message.substring(0, 60)}`); }
    await page.waitForTimeout(1500);
  }

  // 保存
  fs.writeFileSync(CAPTURE_FILE, JSON.stringify(captured, null, 2));
  console.log(`\n=== 完成: 共 ${captured.length} 个请求, 已保存 ===`);

  console.log('\n=== 关键 API 分析 ===');
  for (const e of captured) {
    if ((e.url.includes('signup') || e.url.includes('username') || e.url.includes('_/signup')) && e.postData) {
      console.log(`\nURL: ${e.url}`);
      console.log(`PostData: ${e.postData.substring(0, 500)}`);
      console.log(`Response [${e.status}]: ${(e.body || '').substring(0, 400)}`);
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
