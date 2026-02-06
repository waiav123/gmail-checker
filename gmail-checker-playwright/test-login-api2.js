// 登录页 MI613e API 化 - 修复版
// 直接用模板替换邮箱，不做 JSON 解析
const { chromium } = require('playwright');

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

  let capturedPostData = '', capturedUrl = '';
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('MI613e')) {
      capturedUrl = req.url();
      capturedPostData = req.postData() || '';
    }
  });

  console.log('1. 打开登录页 + 做一次真实检查...');
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.locator('input[type="email"]').fill('capturetemplate999@gmail.com');
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(5000);

  if (!capturedPostData) {
    console.log('❌ 未捕获到 MI613e 请求');
    await browser.close();
    return;
  }

  // 解码 postData
  const decoded = decodeURIComponent(capturedPostData.replace(/\+/g, ' '));
  console.log(`\n2. 捕获的完整 postData:\n${decoded.substring(0, 500)}`);

  // 提取 at (XSRF) token
  const atMatch = decoded.match(/at=([^&]+)/);
  const xsrfToken = atMatch ? atMatch[1] : '';
  console.log(`\n   XSRF: ${xsrfToken.substring(0, 50)}`);

  // 提取 f.req 部分
  const fReqMatch = decoded.match(/f\.req=(.+?)&at=/);
  const fReqTemplate = fReqMatch ? fReqMatch[1] : '';
  console.log(`   f.req template: ${fReqTemplate.substring(0, 200)}`);

  // 回到登录页
  console.log('\n3. 回到登录页，开始 XHR 测试...');
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // 获取新的 XSRF token
  const wizXsrf = await page.evaluate(() => (window.WIZ_global_data || {})['SNlM0e'] || '');
  const activeXsrf = wizXsrf || xsrfToken;
  console.log(`   Active XSRF: ${activeXsrf.substring(0, 50)}`);

  const testEmails = [
    { email: 'dhjfkjshfk234hjkdhkh@gmail.com', expect: 'not-exist' },
    { email: '000001@gmail.com', expect: 'exist' },
    { email: '999999@gmail.com', expect: 'exist' },
    { email: '500000@gmail.com', expect: 'unknown' },
    { email: 'xyzabc123456789@gmail.com', expect: 'not-exist' },
  ];

  for (const tc of testEmails) {
    // 用字符串替换的方式构造请求
    const result = await page.evaluate(async ({ email, template, xsrf, capturedUrl }) => {
      try {
        // 从模板中替换邮箱
        const newFReq = template.replace('capturetemplate999@gmail.com', email);
        const body = `f.req=${encodeURIComponent(newFReq)}&at=${encodeURIComponent(xsrf)}&`;

        // 从捕获的 URL 中提取路径
        const urlPath = new URL(capturedUrl).pathname + '?rpcids=MI613e&source-path=%2Fv3%2Fsignin%2Fidentifier&_reqid=' + Math.floor(Math.random() * 900000 + 100000);

        const r = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', urlPath);
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=utf-8');
          xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
          xhr.onerror = () => reject(new Error('XHR error'));
          xhr.timeout = 10000;
          xhr.ontimeout = () => reject(new Error('timeout'));
          xhr.send(body);
        });

        return { status: r.status, body: r.text, bodyLen: r.text.length };
      } catch (e) {
        return { error: e.message };
      }
    }, { email: tc.email, template: fReqTemplate, xsrf: activeXsrf, capturedUrl });

    process.stdout.write(`  [${tc.email}] `);
    if (result.error) {
      console.log(`❌ ${result.error}`);
    } else {
      const body = result.body;
      let verdict = '未知';
      if (body.includes('LOGIN_CHALLENGE') || body.includes('FIRST_AUTH_FACTOR')) {
        verdict = '✅ 存在';
      } else if (body.includes('rejected') || body.includes('idnf')) {
        verdict = '❌ 不存在 (rejected/idnf)';
      } else if (body.includes('[9]') && result.bodyLen < 300) {
        verdict = '❌ 不存在 (短响应+[9])';
      } else if (result.bodyLen < 250) {
        verdict = '❌ 不存在 (短响应)';
      }
      console.log(`HTTP ${result.status} | Len: ${result.bodyLen} | ${verdict}`);
      // 打印关键部分
      if (result.bodyLen < 400 || body.includes('LOGIN_CHALLENGE') || body.includes('FIRST_AUTH_FACTOR')) {
        console.log(`    ${body.substring(0, 300)}`);
      }
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  // 速率测试：连续发 10 个请求，测量时间
  console.log('\n4. 速率测试（10 个请求，间隔 500ms）...');
  const startTime = Date.now();
  let successCount = 0, failCount = 0;

  for (let i = 0; i < 10; i++) {
    const email = `speedtest${i}abcxyz@gmail.com`;
    const result = await page.evaluate(async ({ email, template, xsrf, capturedUrl }) => {
      try {
        const newFReq = template.replace('capturetemplate999@gmail.com', email);
        const body = `f.req=${encodeURIComponent(newFReq)}&at=${encodeURIComponent(xsrf)}&`;
        const urlPath = new URL(capturedUrl).pathname + '?rpcids=MI613e&source-path=%2Fv3%2Fsignin%2Fidentifier&_reqid=' + Math.floor(Math.random() * 900000 + 100000);
        const r = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', urlPath);
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=utf-8');
          xhr.onload = () => resolve({ status: xhr.status, len: xhr.responseText.length, text: xhr.responseText.substring(0, 100) });
          xhr.onerror = () => reject(new Error('XHR error'));
          xhr.timeout = 10000;
          xhr.ontimeout = () => reject(new Error('timeout'));
          xhr.send(body);
        });
        return r;
      } catch (e) {
        return { error: e.message };
      }
    }, { email, template: fReqTemplate, xsrf: activeXsrf, capturedUrl });

    if (result.error) {
      failCount++;
      process.stdout.write(`❌`);
    } else {
      successCount++;
      process.stdout.write(`✅`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n   ${successCount}/10 成功 | ${elapsed.toFixed(1)}s | ${(10/elapsed).toFixed(1)} req/s`);

  await browser.close();
  console.log('\n🏁 完成');
}

main().catch(console.error);
