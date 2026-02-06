// 深入调研 v3 — 忘记密码流程 + Cookie导出独立HTTP + 登录页DOM并行
// 运行: node research-v3-deep.js
const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');

const RESULTS = {};

function log(section, msg) {
  console.log(`[${section}] ${msg}`);
  if (!RESULTS[section]) RESULTS[section] = [];
  RESULTS[section].push(msg);
}

// ==================== 工具函数 ====================

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}


// ==================== 测试 1: 忘记密码流程 API 化 ====================

async function testRecoveryFlow(browser) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 测试 1: 忘记密码流程 API 化');
  console.log('='.repeat(60));

  const captures = [];
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      captures.push({ url: req.url(), postData: req.postData(), ts: Date.now() });
    }
  });
  page.on('response', async res => {
    if (res.request().method() === 'POST' && res.url().includes('batchexecute')) {
      const entry = captures.find(e => e.url === res.url() && !e.responseBody);
      if (entry) {
        entry.responseBody = await res.text().catch(() => '');
        entry.status = res.status();
        entry.responseLen = entry.responseBody.length;
      }
    }
  });

  // 测试不存在的邮箱
  log('Recovery', '--- 测试不存在的邮箱 ---');
  captures.length = 0;
  await page.goto('https://accounts.google.com/signin/recovery', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const tokens = await page.evaluate(() => {
    const wiz = window.WIZ_global_data || {};
    return { xsrf: wiz['SNlM0e'] || '', fSid: wiz['FdrFJe'] || '', dsh: wiz['Qzxixc'] || '' };
  });
  log('Recovery', `Tokens: xsrf=${tokens.xsrf.substring(0, 30)}... fSid=${tokens.fSid} dsh=${tokens.dsh}`);

  const input = page.locator('input[type="email"], input[type="text"]').first();
  if (await input.count() === 0) {
    log('Recovery', '❌ 找不到输入框');
    await ctx.close();
    return;
  }

  await input.fill('testrecovery777nonexist@gmail.com');
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(5000);

  const bodyText1 = await page.locator('body').innerText().catch(() => '');
  const notFound1 = bodyText1.includes('找不到') || bodyText1.includes("Couldn't find");
  log('Recovery', `不存在邮箱: notFound=${notFound1} | 捕获请求数=${captures.length}`);

  for (const cap of captures) {
    const rpcMatch = cap.url.match(/rpcids=([^&]+)/);
    log('Recovery', `  RPC: ${rpcMatch ? rpcMatch[1] : 'unknown'} | Status: ${cap.status} | Len: ${cap.responseLen}`);
    log('Recovery', `  URL: ${cap.url.substring(0, 120)}`);
    log('Recovery', `  Response: ${(cap.responseBody || '').substring(0, 300)}`);
    
    // 提取 f.req 模板
    if (cap.postData) {
      const decoded = decodeURIComponent(cap.postData.replace(/\+/g, ' '));
      log('Recovery', `  PostData: ${decoded.substring(0, 300)}`);
    }
  }

  // 测试存在的邮箱
  log('Recovery', '\n--- 测试存在的邮箱 ---');
  captures.length = 0;
  await page.goto('https://accounts.google.com/signin/recovery', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const input2 = page.locator('input[type="email"], input[type="text"]').first();
  await input2.fill('000001@gmail.com');
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(5000);

  const bodyText2 = await page.locator('body').innerText().catch(() => '');
  const finalUrl2 = page.url();
  log('Recovery', `存在邮箱: URL=${finalUrl2.substring(0, 80)} | 捕获请求数=${captures.length}`);
  log('Recovery', `页面文本: ${bodyText2.substring(0, 200)}`);

  for (const cap of captures) {
    const rpcMatch = cap.url.match(/rpcids=([^&]+)/);
    log('Recovery', `  RPC: ${rpcMatch ? rpcMatch[1] : 'unknown'} | Status: ${cap.status} | Len: ${cap.responseLen}`);
    log('Recovery', `  Response: ${(cap.responseBody || '').substring(0, 300)}`);
  }

  // 尝试 XHR 复用（和登录页一样测试是否有 session 签名限制）
  if (captures.length > 0) {
    log('Recovery', '\n--- 测试 XHR 复用 ---');
    const lastCap = captures[captures.length - 1];
    const decoded = decodeURIComponent(lastCap.postData.replace(/\+/g, ' '));
    const fReqMatch = decoded.match(/f\.req=(.+?)&at=/s);
    const atMatch = decoded.match(/at=([^&]+)/);
    
    if (fReqMatch && atMatch) {
      const template = fReqMatch[1];
      const xsrf = atMatch[1];
      
      // 回到恢复页
      await page.goto('https://accounts.google.com/signin/recovery', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      const newXsrf = await page.evaluate(() => (window.WIZ_global_data || {})['SNlM0e'] || '');
      
      const testEmails = ['testxhr111@gmail.com', '999999@gmail.com'];
      for (const email of testEmails) {
        const result = await page.evaluate(async ({ email, template, xsrf, origEmail, capturedUrl }) => {
          try {
            const newFReq = template.replace(new RegExp(origEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), email);
            const body = `f.req=${encodeURIComponent(newFReq)}&at=${encodeURIComponent(xsrf)}&`;
            const urlObj = new URL(capturedUrl);
            const urlPath = urlObj.pathname + '?' + urlObj.searchParams.toString();
            
            const r = await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', urlPath);
              xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=utf-8');
              xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, len: xhr.responseText.length });
              xhr.onerror = () => reject(new Error('XHR error'));
              xhr.timeout = 10000;
              xhr.ontimeout = () => reject(new Error('timeout'));
              xhr.send(body);
            });
            return { email, status: r.status, len: r.len, snippet: r.text.substring(0, 250) };
          } catch (e) {
            return { email, error: e.message };
          }
        }, { email, template, xsrf: newXsrf || xsrf, origEmail: '000001@gmail.com', capturedUrl: lastCap.url });
        
        log('Recovery', `  XHR [${email}]: ${JSON.stringify(result).substring(0, 200)}`);
        await page.waitForTimeout(1000);
      }
    }
  }

  await ctx.close();
}


// ==================== 测试 2: Cookie 导出 + 独立 HTTP 请求 ====================

async function testCookieExportHTTP(browser) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 测试 2: Cookie 导出 + 独立 HTTP (注册页 NHJMOd)');
  console.log('='.repeat(60));

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  let capturedUrl = '', capturedBody = '';
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('NHJMOd')) {
      capturedUrl = req.url();
      capturedBody = req.postData() || '';
    }
  });

  // 走注册流程到用户名页面
  log('CookieHTTP', '走注册流程...');
  await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 填名字
  try {
    const ni = page.locator('input[type="text"]:visible');
    if (await ni.count() >= 2) { await ni.nth(0).fill('Test'); await ni.nth(1).fill('User'); }
    else if (await ni.count() >= 1) { await ni.nth(0).fill('Test'); }
    await page.waitForTimeout(500);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
  } catch (e) { log('CookieHTTP', `填名字失败: ${e.message.substring(0, 50)}`); }

  // 填生日
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
  } catch (e) { log('CookieHTTP', `填生日失败: ${e.message.substring(0, 50)}`); }

  // 选择自定义用户名
  try {
    const radios = page.locator('[role="radio"], input[type="radio"]');
    if (await radios.count() > 0) {
      await radios.nth((await radios.count()) - 1).click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  // 做一次真实检查来触发 NHJMOd
  try {
    const input = page.locator('input[type="text"]:visible').first();
    await input.fill('cookietest12345xyz');
    await page.waitForTimeout(300);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
    if (page.url().includes('/password')) {
      await page.goBack();
      await page.waitForTimeout(3000);
      try {
        const r = page.locator('[role="radio"]');
        if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(800); }
      } catch {}
    }
  } catch {}

  if (!capturedUrl) {
    log('CookieHTTP', '❌ 未捕获到 NHJMOd 请求');
    await ctx.close();
    return;
  }

  log('CookieHTTP', `✅ 捕获到 NHJMOd 请求`);

  // 导出 cookies（通过 CDP 获取完整 cookies）
  const cdpSession = await ctx.newCDPSession(page);
  const { cookies } = await cdpSession.send('Network.getAllCookies');
  const googleCookies = cookies.filter(c => c.domain.includes('google'));
  
  log('CookieHTTP', `Cookies: 总共 ${cookies.length} 个, Google ${googleCookies.length} 个`);
  for (const c of googleCookies) {
    log('CookieHTTP', `  ${c.name}: domain=${c.domain} httpOnly=${c.httpOnly} secure=${c.secure} value=${c.value.substring(0, 30)}...`);
  }

  // 提取 tokens
  const wizData = await page.evaluate(() => {
    const wiz = window.WIZ_global_data || {};
    return { xsrf: wiz['SNlM0e'] || '', fSid: wiz['FdrFJe'] || '', dsh: wiz['Qzxixc'] || '' };
  });
  
  const tlMatch = capturedUrl.match(/TL=([^&]+)/);
  const tlToken = tlMatch ? decodeURIComponent(tlMatch[1]) : '';
  
  log('CookieHTTP', `XSRF: ${wizData.xsrf.substring(0, 30)}...`);
  log('CookieHTTP', `TL: ${tlToken.substring(0, 30)}...`);

  // 构造 cookie 字符串
  const cookieStr = googleCookies
    .filter(c => c.domain.includes('.google.com') || c.domain.includes('accounts.google'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  log('CookieHTTP', `Cookie 字符串长度: ${cookieStr.length}`);

  // 用 Node.js https 直接发请求（脱离浏览器）
  log('CookieHTTP', '\n--- 独立 HTTP 请求测试 ---');
  
  const testUsernames = ['dhjfkjshfk234hjkdhkh', '000001', '999999', 'xyztest123456'];
  
  for (const username of testUsernames) {
    try {
      const innerData = `["${username}",1,0,null,[null,null,null,null,0,${Date.now() % 1000000}],0,40]`;
      const reqData = `[["NHJMOd",${JSON.stringify(innerData)},null,"generic"]]`;
      const body = `f.req=${encodeURIComponent(`[${reqData}]`)}&at=${encodeURIComponent(wizData.xsrf)}&`;
      
      const url = `https://accounts.google.com/lifecycle/_/AccountLifecyclePlatformSignupUi/data/batchexecute?rpcids=NHJMOd&TL=${encodeURIComponent(tlToken)}&rt=c&_reqid=${Math.floor(Math.random() * 900000) + 100000}`;
      
      const result = await httpsPost(url, {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Cookie': cookieStr,
        'Origin': 'https://accounts.google.com',
        'Referer': 'https://accounts.google.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }, body);
      
      let verdict = 'unknown';
      if (result.body.includes('steps/signup/password')) verdict = '✅ AVAILABLE';
      else if (result.body.includes('[null,[]]')) verdict = '⚠️ DEGRADED';
      else if (result.body.includes('[null,[[')) verdict = '❌ TAKEN';
      else if (result.status === 401) verdict = '🔒 AUTH_FAIL';
      else if (result.status === 403) verdict = '🔒 FORBIDDEN';
      
      log('CookieHTTP', `  [${username}] HTTP ${result.status} | Len: ${result.body.length} | ${verdict}`);
      log('CookieHTTP', `    Response: ${result.body.substring(0, 200)}`);
    } catch (e) {
      log('CookieHTTP', `  [${username}] ❌ Error: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }

  await cdpSession.detach();
  await ctx.close();
}


// ==================== 测试 3: 登录页 DOM 并行速度测试 ====================

async function testLoginDomParallel(browser) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 测试 3: 登录页 DOM 并行速度测试');
  console.log('='.repeat(60));

  // 单 context 速度测试
  log('LoginDOM', '--- 单 context 速度测试 ---');
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  const testEmails = [
    { email: 'speedtest1abc@gmail.com', expect: 'not-exist' },
    { email: '000001@gmail.com', expect: 'exist' },
    { email: 'speedtest2xyz@gmail.com', expect: 'not-exist' },
    { email: '999999@gmail.com', expect: 'exist' },
    { email: 'speedtest3def@gmail.com', expect: 'not-exist' },
  ];

  const startTime = Date.now();
  let successCount = 0;

  for (const tc of testEmails) {
    try {
      await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      
      const emailInput = page.locator('input[type="email"]');
      if (await emailInput.count() === 0) {
        log('LoginDOM', `  [${tc.email}] ❌ 找不到输入框`);
        continue;
      }
      
      await emailInput.fill(tc.email);
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(3000);
      
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const finalUrl = page.url();
      
      let verdict = 'unknown';
      if (bodyText.includes('找不到') || bodyText.includes("Couldn't find")) verdict = 'NOT_EXISTS';
      else if (finalUrl.includes('challenge') || finalUrl.includes('password')) verdict = 'EXISTS';
      
      log('LoginDOM', `  [${tc.email}] ${verdict} (expect: ${tc.expect})`);
      successCount++;
    } catch (e) {
      log('LoginDOM', `  [${tc.email}] ❌ ${e.message.substring(0, 50)}`);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  log('LoginDOM', `单 context: ${successCount}/${testEmails.length} 成功 | ${elapsed.toFixed(1)}s | ${(successCount/elapsed).toFixed(2)} req/s`);

  await ctx.close();

  // 3 context 并行速度测试
  log('LoginDOM', '\n--- 3 context 并行速度测试 ---');
  
  const contexts = await Promise.all([
    browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0' }),
    browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0' }),
    browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118.0.0.0' }),
  ]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));

  async function checkEmailDOM(pg, email) {
    try {
      await pg.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await pg.waitForTimeout(1500);
      await pg.locator('input[type="email"]').fill(email);
      await pg.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await pg.waitForTimeout(3000);
      const bodyText = await pg.locator('body').innerText().catch(() => '');
      const finalUrl = pg.url();
      if (bodyText.includes('找不到') || bodyText.includes("Couldn't find")) return 'NOT_EXISTS';
      if (finalUrl.includes('challenge') || finalUrl.includes('password')) return 'EXISTS';
      return 'UNKNOWN';
    } catch (e) {
      return `ERROR: ${e.message.substring(0, 30)}`;
    }
  }

  const parallelEmails = [
    ['para1a@gmail.com', 'para1b@gmail.com', 'para1c@gmail.com'],
    ['000001@gmail.com', 'para2b@gmail.com', '999999@gmail.com'],
  ];

  const pStartTime = Date.now();
  let pSuccess = 0;

  for (const batch of parallelEmails) {
    const results = await Promise.all(
      batch.map((email, i) => checkEmailDOM(pages[i], email))
    );
    for (let i = 0; i < batch.length; i++) {
      log('LoginDOM', `  [${batch[i]}] ${results[i]}`);
      if (!results[i].startsWith('ERROR')) pSuccess++;
    }
  }

  const pElapsed = (Date.now() - pStartTime) / 1000;
  log('LoginDOM', `3 context 并行: ${pSuccess}/6 成功 | ${pElapsed.toFixed(1)}s | ${(pSuccess/pElapsed).toFixed(2)} req/s`);

  for (const c of contexts) await c.close().catch(() => {});
}


// ==================== 测试 4: 注册页多 context 并行 + 自适应速率 ====================

async function testSignupMultiContext(browser) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 测试 4: 注册页多 context 并行 + 速率测试');
  console.log('='.repeat(60));

  // 复用 checker-api-fast.js 的 setupSession
  async function setupSession(browser) {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);

    let xsrfToken = '', tlToken = '';
    page.on('request', req => {
      if (req.method() === 'POST' && req.url().includes('batchexecute')) {
        const pd = req.postData() || '';
        const atMatch = pd.match(/at=([^&]+)/);
        if (atMatch) xsrfToken = decodeURIComponent(atMatch[1]);
        try {
          const u = new URL(req.url());
          tlToken = u.searchParams.get('TL') || tlToken;
        } catch {}
      }
    });

    await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 填名字
    try {
      const ni = page.locator('input[type="text"]:visible');
      if (await ni.count() >= 2) { await ni.nth(0).fill('Test'); await ni.nth(1).fill('User'); }
      else if (await ni.count() >= 1) { await ni.nth(0).fill('Test'); }
      await page.waitForTimeout(300);
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(3000);
    } catch {}

    // 填生日
    try {
      await page.waitForSelector('input', { timeout: 8000 });
      await page.locator('input').first().fill('1990');
      await page.waitForTimeout(200);
      await page.locator('[role="combobox"]').first().click();
      await page.waitForTimeout(300);
      await page.locator('[role="listbox"]:visible [role="option"]').first().click();
      await page.waitForTimeout(300);
      await page.locator('input').nth(1).fill('15');
      await page.waitForTimeout(200);
      await page.locator('[role="combobox"]').nth(1).click();
      await page.waitForTimeout(300);
      await page.locator('[role="listbox"]:visible [role="option"]').nth(1).click();
      await page.waitForTimeout(300);
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(3000);
    } catch {}

    // 选自定义用户名
    try {
      const radios = page.locator('[role="radio"]');
      if (await radios.count() > 0) { await radios.nth((await radios.count())-1).click(); await page.waitForTimeout(800); }
    } catch {}

    // 触发一次 API 请求
    try {
      const input = page.locator('input[type="text"]:visible').first();
      await input.fill('sessioninit12345');
      await page.waitForTimeout(200);
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(3000);
      if (page.url().includes('/password')) {
        await page.goBack();
        await page.waitForTimeout(2000);
        try { const r = page.locator('[role="radio"]'); if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(500); } } catch {}
      }
    } catch {}

    // 提取 tokens
    try {
      const wizData = await page.evaluate(() => {
        const wiz = window.WIZ_global_data || {};
        return { xsrf: wiz['SNlM0e'] || '', fSid: wiz['FdrFJe'] || '', dsh: wiz['Qzxixc'] || '' };
      });
      if (wizData.xsrf) xsrfToken = wizData.xsrf;
    } catch {}

    try {
      const u = new URL(page.url());
      tlToken = tlToken || u.searchParams.get('TL') || '';
    } catch {}

    return { page, ctx, xsrfToken, tlToken };
  }

  // 建立 2 个 session（3 个可能太慢）
  log('MultiCtx', '建立 2 个 session...');
  const startSetup = Date.now();
  
  let sessions;
  try {
    sessions = [];
    for (let i = 0; i < 2; i++) {
      log('MultiCtx', `  建立 session ${i+1}...`);
      const s = await setupSession(browser);
      sessions.push(s);
      log('MultiCtx', `  Session ${i+1}: xsrf=${s.xsrfToken.substring(0, 20)}... TL=${s.tlToken.substring(0, 20)}...`);
    }
  } catch (e) {
    log('MultiCtx', `❌ Session 建立失败: ${e.message.substring(0, 60)}`);
    return;
  }

  const setupTime = (Date.now() - startSetup) / 1000;
  log('MultiCtx', `Session 建立耗时: ${setupTime.toFixed(1)}s`);

  // 并行速率测试：每个 session 发 5 个请求
  log('MultiCtx', '\n--- 并行速率测试 ---');
  
  async function checkUsername(page, username, xsrfToken, tlToken) {
    return await page.evaluate(async ({ username, xsrfToken, tlToken }) => {
      const innerData = `["${username}",1,0,null,[null,null,null,null,0,${Date.now() % 1000000}],0,40]`;
      const reqData = `[["NHJMOd",${JSON.stringify(innerData)},null,"generic"]]`;
      const body = `f.req=${encodeURIComponent(`[${reqData}]`)}&at=${encodeURIComponent(xsrfToken)}&`;
      const url = `/lifecycle/_/AccountLifecyclePlatformSignupUi/data/batchexecute?rpcids=NHJMOd&TL=${encodeURIComponent(tlToken)}&rt=c&_reqid=${Math.floor(Math.random() * 900000) + 100000}`;
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
        const flat = r.text;
        if (flat.includes('steps/signup/password')) return 'available';
        if (flat.includes('[null,[]]')) return 'degraded';
        if (flat.includes('[null,[[')) return 'taken';
        return 'unknown';
      } catch (e) {
        return `error:${e.message.substring(0, 20)}`;
      }
    }, { username, xsrfToken, tlToken });
  }

  // 测试不同间隔
  for (const delay of [500, 300, 200]) {
    log('MultiCtx', `\n  间隔 ${delay}ms 测试:`);
    const tStart = Date.now();
    let count = 0, degraded = 0;
    
    for (let i = 0; i < 5; i++) {
      // 两个 session 并行
      const results = await Promise.all(
        sessions.map((s, idx) => 
          checkUsername(s.page, `ratetest${delay}_${i}_${idx}`, s.xsrfToken, s.tlToken)
        )
      );
      for (const r of results) {
        count++;
        if (r === 'degraded') degraded++;
      }
      await new Promise(r => setTimeout(r, delay));
    }
    
    const tElapsed = (Date.now() - tStart) / 1000;
    log('MultiCtx', `    ${count} 请求 | ${tElapsed.toFixed(1)}s | ${(count/tElapsed).toFixed(1)} req/s | 降级: ${degraded}`);
  }

  // 清理
  for (const s of sessions) {
    try { await s.ctx.close(); } catch {}
  }
}


// ==================== 主流程 ====================

async function main() {
  console.log('🚀 深入调研 v3 开始\n');
  
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  try {
    await testRecoveryFlow(browser);
  } catch (e) {
    console.error('Recovery 测试失败:', e.message.substring(0, 100));
  }

  try {
    await testCookieExportHTTP(browser);
  } catch (e) {
    console.error('Cookie HTTP 测试失败:', e.message.substring(0, 100));
  }

  try {
    await testLoginDomParallel(browser);
  } catch (e) {
    console.error('Login DOM 测试失败:', e.message.substring(0, 100));
  }

  try {
    await testSignupMultiContext(browser);
  } catch (e) {
    console.error('Multi Context 测试失败:', e.message.substring(0, 100));
  }

  // 保存结果
  fs.writeFileSync('research-v3-results.json', JSON.stringify(RESULTS, null, 2));
  
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 调研结果汇总');
  console.log('='.repeat(60));
  
  for (const [section, msgs] of Object.entries(RESULTS)) {
    console.log(`\n--- ${section} ---`);
    for (const msg of msgs) console.log(`  ${msg}`);
  }
  
  console.log('\n📁 详细结果已保存到 research-v3-results.json');

  await browser.close();
  console.log('\n🏁 调研完成');
}

main().catch(err => {
  console.error('致命错误:', err);
  fs.writeFileSync('research-v3-results.json', JSON.stringify(RESULTS, null, 2));
  process.exit(1);
});
