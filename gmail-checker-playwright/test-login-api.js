// 测试登录页 MI613e API 化 - 在浏览器内用 XHR 直接调用
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

  // 捕获真实的 MI613e 请求格式
  let realPostData = '', realUrl = '', xsrfToken = '';
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('MI613e')) {
      realUrl = req.url();
      realPostData = req.postData() || '';
      const atMatch = realPostData.match(/at=([^&]+)/);
      if (atMatch) xsrfToken = decodeURIComponent(atMatch[1]);
    }
  });

  // 打开登录页并做一次真实的 DOM 检查来捕获请求格式
  console.log('1. 打开登录页...');
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  console.log('2. 做一次真实 DOM 检查来捕获请求格式...');
  const emailInput = page.locator('input[type="email"]');
  await emailInput.fill('capturetest12345xyz@gmail.com');
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(5000);

  console.log(`   捕获到 URL: ${realUrl.substring(0, 100)}`);
  console.log(`   PostData: ${realPostData.substring(0, 200)}`);
  console.log(`   XSRF: ${xsrfToken.substring(0, 40)}...`);

  // 解析真实请求中的 f.req 格式
  console.log('\n3. 解析真实请求格式...');
  const fReqMatch = realPostData.match(/f\.req=([^&]+)/);
  if (fReqMatch) {
    const decoded = decodeURIComponent(fReqMatch[1]);
    console.log(`   f.req (decoded): ${decoded.substring(0, 300)}`);

    // 提取 MI613e 的内部数据格式
    try {
      const outer = JSON.parse(decoded);
      if (outer[0] && outer[0][0] === 'MI613e') {
        const innerStr = outer[0][1];
        console.log(`   Inner data: ${innerStr.substring(0, 200)}`);
        const inner = JSON.parse(innerStr);
        console.log(`   Inner array length: ${inner.length}`);
        console.log(`   Inner[1] (email): ${inner[1]}`);
        // 找到所有非 null 的字段
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] !== null) {
            console.log(`   Inner[${i}]: ${JSON.stringify(inner[i]).substring(0, 80)}`);
          }
        }
      }
    } catch (e) {
      console.log(`   解析失败: ${e.message}`);
    }
  }

  // 提取 URL 参数
  console.log('\n4. URL 参数:');
  try {
    const u = new URL(realUrl);
    for (const [k, v] of u.searchParams) {
      console.log(`   ${k}: ${v.substring(0, 60)}`);
    }
  } catch {}

  // 现在用 XHR 直接调用 MI613e
  console.log('\n5. XHR 直接调用 MI613e...');

  // 回到登录页（保持 session）
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // 从页面提取 WIZ_global_data
  const wizData = await page.evaluate(() => {
    const wiz = window.WIZ_global_data || {};
    return { xsrf: wiz['SNlM0e'] || '', fSid: wiz['FdrFJe'] || '', dsh: wiz['Qzxixc'] || '' };
  });
  console.log(`   WIZ XSRF: ${wizData.xsrf.substring(0, 40)}...`);

  const testEmails = [
    'dhjfkjshfk234hjkdhkh@gmail.com',  // 不存在
    '000001@gmail.com',                  // 存在
    '999999@gmail.com',                  // 存在
    '500000@gmail.com',                  // 未知
    'xyzabc123456789@gmail.com',         // 不存在
  ];

  for (const email of testEmails) {
    const result = await page.evaluate(async ({ email, xsrfToken, realPostData }) => {
      // 从真实请求中提取模板，替换邮箱
      const fReqMatch = realPostData.match(/f\.req=([^&]+)/);
      if (!fReqMatch) return { error: 'no f.req in captured data' };

      const decoded = decodeURIComponent(fReqMatch[1]);
      try {
        const outer = JSON.parse(decoded);
        const innerStr = outer[0][1];
        const inner = JSON.parse(innerStr);

        // 替换邮箱
        inner[1] = email;

        // 重新编码
        const newInner = JSON.stringify(inner);
        outer[0][1] = newInner;
        const newFReq = JSON.stringify(outer);

        const body = `f.req=${encodeURIComponent(newFReq)}&at=${encodeURIComponent(xsrfToken)}&`;

        const url = `/v3/signin/_/AccountsSignInUi/data/batchexecute?rpcids=MI613e&source-path=%2Fv3%2Fsignin%2Fidentifier&_reqid=${Math.floor(Math.random() * 900000) + 100000}`;

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

        return { status: r.status, body: r.text.substring(0, 500), bodyLen: r.text.length };
      } catch (e) {
        return { error: e.message };
      }
    }, { email, xsrfToken: wizData.xsrf || xsrfToken, realPostData });

    console.log(`\n  [${email}]`);
    if (result.error) {
      console.log(`    ❌ Error: ${result.error}`);
    } else {
      console.log(`    HTTP ${result.status} | Length: ${result.bodyLen}`);
      console.log(`    Body: ${result.body.substring(0, 300)}`);

      // 判定
      const body = result.body;
      if (body.includes('LOGIN_CHALLENGE') || body.includes('FIRST_AUTH_FACTOR')) {
        console.log(`    ✅ 判定: 存在`);
      } else if (body.includes('rejected') || body.includes('idnf') || result.bodyLen < 300) {
        console.log(`    ❌ 判定: 不存在`);
      } else if (body.includes('[9]') && result.bodyLen < 250) {
        console.log(`    ❌ 判定: 不存在 (短响应)`);
      } else {
        console.log(`    🔬 判定: 未知`);
      }
    }

    await new Promise(r => setTimeout(r, 1000)); // 间隔 1s
  }

  await browser.close();
  console.log('\n🏁 登录页 API 化测试完成');
}

main().catch(console.error);
