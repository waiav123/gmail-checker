// 精确对比浏览器真实请求 vs fetch 请求的差异
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // 捕获真实请求的完整 headers
  const realRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('NHJMOd')) {
      realRequests.push({
        url: req.url(),
        headers: req.headers(),
        postData: req.postData(),
      });
    }
  });

  // 走到用户名页面
  console.log('初始化...');
  await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  try {
    const ni = page.locator('input[type="text"]:visible');
    if (await ni.count() >= 2) { await ni.nth(0).fill('Test'); await ni.nth(1).fill('User'); }
    await page.waitForTimeout(500);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
  } catch {}

  // 生日 - 更健壮的填写
  console.log('填生日...');
  try {
    await page.waitForTimeout(2000);
    // 年份 - 找到标签为"年"的输入框
    const yearInput = page.locator('input:visible').first();
    await yearInput.fill('1990');
    await page.waitForTimeout(500);

    // 月份下拉框
    const combos = page.locator('[role="combobox"]:visible, select:visible');
    const comboCount = await combos.count();
    console.log(`  下拉框数量: ${comboCount}`);
    
    if (comboCount >= 1) {
      await combos.nth(0).click();
      await page.waitForTimeout(500);
      // 选择第二个选项（跳过空选项）
      const options = page.locator('[role="option"]:visible, [role="listbox"]:visible [role="option"]');
      const optCount = await options.count();
      console.log(`  月份选项数量: ${optCount}`);
      if (optCount > 1) await options.nth(1).click();
      else if (optCount > 0) await options.nth(0).click();
      await page.waitForTimeout(500);
    }

    // 日期
    const dayInput = page.locator('input:visible').nth(1);
    await dayInput.fill('15');
    await page.waitForTimeout(500);

    // 性别下拉框
    if (comboCount >= 2) {
      await combos.nth(1).click();
      await page.waitForTimeout(500);
      const genderOpts = page.locator('[role="option"]:visible, [role="listbox"]:visible [role="option"]');
      const gOptCount = await genderOpts.count();
      console.log(`  性别选项数量: ${gOptCount}`);
      if (gOptCount > 1) await genderOpts.nth(1).click();
      else if (gOptCount > 0) await genderOpts.nth(0).click();
      await page.waitForTimeout(500);
    }

    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
    console.log('  生日 OK');
  } catch (e) {
    console.log(`  生日失败: ${e.message.substring(0, 60)}`);
  }

  try {
    const r = page.locator('[role="radio"]');
    if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(1000); }
  } catch {}

  // 做一次真实的 DOM 检查来捕获真实请求
  console.log('\n=== 做一次真实 DOM 检查 ===');
  console.log(`当前 URL: ${page.url()}`);
  
  // 等待输入框出现
  await page.waitForTimeout(2000);
  const allInputs = page.locator('input:visible');
  console.log(`可见 input 数量: ${await allInputs.count()}`);
  
  const input = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
  const inputCount = await input.count();
  console.log(`目标 input 数量: ${inputCount}`);
  
  if (inputCount === 0) {
    // 可能需要等待或者页面结构不同
    console.log('找不到输入框，尝试截图...');
    await page.screenshot({ path: 'debug-username-page.png', fullPage: true });
    console.log('截图已保存: debug-username-page.png');
    // 打印页面文本
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log(`页面文本: ${bodyText.substring(0, 300)}`);
    await browser.close();
    return;
  }
  await input.fill('testcheck776567');
  await page.waitForTimeout(300);
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(4000);

  if (realRequests.length > 0) {
    const real = realRequests[realRequests.length - 1];
    console.log('\n=== 真实请求 Headers ===');
    for (const [k, v] of Object.entries(real.headers)) {
      console.log(`  ${k}: ${v.substring(0, 120)}`);
    }
    console.log(`\n=== 真实请求 URL ===`);
    console.log(`  ${real.url}`);
    console.log(`\n=== 真实请求 PostData ===`);
    console.log(`  ${real.postData.substring(0, 300)}`);

    // 现在用 fetch 发一个一模一样的请求
    console.log('\n=== 用 fetch 复制完全相同的请求 ===');
    const fetchRes = await page.evaluate(async ({ url, headers, postData }) => {
      try {
        // 完全复制真实请求的 headers
        const r = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: postData,
          credentials: 'include',
        });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { error: e.message };
      }
    }, { url: real.url, headers: real.headers, postData: real.postData });

    console.log(`  fetch 结果: HTTP ${fetchRes.status}`);
    console.log(`  snippet: ${(fetchRes.text || fetchRes.error || '').substring(0, 200)}`);

    // 对比：哪些 header 是 fetch 不能设置的？
    console.log('\n=== fetch 不能设置的 Headers (forbidden headers) ===');
    const forbidden = ['cookie', 'host', 'origin', 'referer', 'user-agent', 'sec-', 'accept-encoding'];
    for (const [k, v] of Object.entries(real.headers)) {
      if (forbidden.some(f => k.toLowerCase().startsWith(f))) {
        console.log(`  ⚠️ ${k}: ${v.substring(0, 80)}`);
      }
    }
  } else {
    console.log('没有捕获到 NHJMOd 请求');
  }

  await browser.close();
}

main().catch(console.error);
