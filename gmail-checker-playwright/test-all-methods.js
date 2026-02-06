// 全量方案测试 - 通过 Playwright 浏览器内发请求（绕过本地网络限制）
const { chromium } = require('playwright');
const fs = require('fs');

const RESULTS = [];
function logResult(method, status, detail) {
  const r = { method, status, detail: typeof detail === 'string' ? detail.substring(0, 200) : detail };
  RESULTS.push(r);
  const icon = status === 'SUCCESS' ? '✅' : status === 'FAIL' ? '❌' : '🔬';
  console.log(`${icon} [${method}] ${status}: ${r.detail}`);
}

async function main() {
  console.log('🚀 全量方案测试开始\n');
  console.log('=' .repeat(60));

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // ============================================================
  // 测试 1: Identity Toolkit - createAuthUri
  // ============================================================
  console.log('\n📋 测试 1: Identity Toolkit createAuthUri');
  console.log('-'.repeat(40));
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1000);

  const publicKeys = [
    'AIzaSyB6ZODYFbBPqLFm-hlMZjm7Z3Btmlk-axo',
    'AIzaSyAa8yy0GdcGPHdtD083HiGGx_S0vMPScDM',
  ];

  for (const key of publicKeys) {
    const idtResult = await page.evaluate(async ({ key }) => {
      const results = {};
      const endpoints = [
        { name: 'createAuthUri', url: `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`, body: { identifier: 'test@gmail.com', continueUri: 'http://localhost' } },
        { name: 'createAuthUri-noexist', url: `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`, body: { identifier: 'dhjfkjshfk234hjkdhkh@gmail.com', continueUri: 'http://localhost' } },
        { name: 'signInWithPassword-exist', url: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, body: { email: 'test@gmail.com', password: 'wrong123', returnSecureToken: true } },
        { name: 'signInWithPassword-noexist', url: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, body: { email: 'dhjfkjshfk234hjkdhkh@gmail.com', password: 'wrong123', returnSecureToken: true } },
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ep.body)
          });
          const text = await r.text();
          results[ep.name] = { status: r.status, body: text.substring(0, 300) };
        } catch (e) {
          results[ep.name] = { error: e.message };
        }
      }
      return results;
    }, { key });

    for (const [name, res] of Object.entries(idtResult)) {
      if (res.error) {
        logResult(`IDT:${name}(key:${key.substring(0,10)})`, 'FAIL', res.error);
      } else {
        logResult(`IDT:${name}(key:${key.substring(0,10)})`, res.status === 200 ? 'SUCCESS' : 'INFO', `HTTP ${res.status} | ${res.body}`);
      }
    }
  }

  // ============================================================
  // 测试 2: 登录页 MI613e RPC
  // ============================================================
  console.log('\n📋 测试 2: 登录页 MI613e RPC');
  console.log('-'.repeat(40));

  const loginCaptures = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      loginCaptures.push({ url: req.url(), postData: req.postData(), headers: req.headers() });
    }
  });
  page.on('response', async res => {
    if (res.request().method() === 'POST' && res.url().includes('batchexecute')) {
      const entry = loginCaptures.find(e => e.url === res.url() && !e.responseBody);
      if (entry) { entry.responseBody = await res.text().catch(() => ''); entry.status = res.status(); }
    }
  });

  // 测试不存在的邮箱
  try {
    await page.goto('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.count() > 0) {
      loginCaptures.length = 0;
      await emailInput.fill('dhjfkjshfk234hjkdhkh@gmail.com');
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(5000);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const hasNotFound = bodyText.includes('找不到') || bodyText.includes("Couldn't find") || bodyText.includes('not find');
      logResult('Login-nonexist', hasNotFound ? 'SUCCESS' : 'INFO', `Found "not found": ${hasNotFound} | URL: ${page.url().substring(0, 80)} | Captures: ${loginCaptures.length}`);
      if (loginCaptures.length > 0) {
        const last = loginCaptures[loginCaptures.length - 1];
        logResult('Login-RPC-capture', 'INFO', `URL: ${last.url.substring(0, 100)} | Response: ${(last.responseBody || '').substring(0, 150)}`);
      }
    } else {
      logResult('Login-nonexist', 'FAIL', '找不到 email 输入框');
    }
  } catch (e) {
    logResult('Login-nonexist', 'FAIL', e.message.substring(0, 100));
  }

  // 测试存在的邮箱
  try {
    loginCaptures.length = 0;
    await page.goto('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const emailInput2 = page.locator('input[type="email"]');
    if (await emailInput2.count() > 0) {
      await emailInput2.fill('test@gmail.com');
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(5000);
      const url2 = page.url();
      const hasPassword = url2.includes('challenge') || url2.includes('password') || url2.includes('signin/v2/challenge');
      logResult('Login-exist', hasPassword ? 'SUCCESS' : 'INFO', `Password page: ${hasPassword} | URL: ${url2.substring(0, 80)} | Captures: ${loginCaptures.length}`);
      if (loginCaptures.length > 0) {
        const last = loginCaptures[loginCaptures.length - 1];
        logResult('Login-exist-RPC', 'INFO', `URL: ${last.url.substring(0, 100)} | Response: ${(last.responseBody || '').substring(0, 150)}`);
      }
    }
  } catch (e) {
    logResult('Login-exist', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 3: 忘记密码流程
  // ============================================================
  console.log('\n📋 测试 3: 忘记密码流程');
  console.log('-'.repeat(40));

  try {
    loginCaptures.length = 0;
    await page.goto('https://accounts.google.com/signin/v2/recoveryidentifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    // 也可能是 /signin/recovery
    let currentUrl = page.url();
    if (!currentUrl.includes('recovery') && !currentUrl.includes('Recovery')) {
      await page.goto('https://accounts.google.com/signin/recovery', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }
    const recoveryInput = page.locator('input[type="email"], input[type="text"]').first();
    if (await recoveryInput.count() > 0) {
      await recoveryInput.fill('dhjfkjshfk234hjkdhkh@gmail.com');
      await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
      await page.waitForTimeout(5000);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const notFound = bodyText.includes('找不到') || bodyText.includes("Couldn't find") || bodyText.includes('not find') || bodyText.includes('无法找到');
      logResult('Recovery-nonexist', notFound ? 'SUCCESS' : 'INFO', `Not found: ${notFound} | Text: ${bodyText.substring(0, 100)}`);
    } else {
      logResult('Recovery', 'FAIL', '找不到输入框');
    }
  } catch (e) {
    logResult('Recovery', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 4: 不同注册入口 (flowName 变体)
  // ============================================================
  console.log('\n📋 测试 4: 不同注册入口');
  console.log('-'.repeat(40));

  const signupUrls = [
    { name: 'AddSession', url: 'https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=AddSession' },
    { name: 'ServiceLogin', url: 'https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=ServiceLogin' },
    { name: 'NoFlowEntry', url: 'https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn' },
    { name: 'SignUpDirect', url: 'https://accounts.google.com/SignUp' },
  ];

  for (const su of signupUrls) {
    try {
      await page.goto(su.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const finalUrl = page.url();
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const hasNameField = bodyText.includes('姓名') || bodyText.includes('name') || bodyText.includes('Name');
      logResult(`Signup-${su.name}`, 'INFO', `URL: ${finalUrl.substring(0, 80)} | HasName: ${hasNameField}`);
    } catch (e) {
      logResult(`Signup-${su.name}`, 'FAIL', e.message.substring(0, 80));
    }
  }

  // ============================================================
  // 测试 5: Google 域名变体
  // ============================================================
  console.log('\n📋 测试 5: Google 域名变体');
  console.log('-'.repeat(40));

  const domains = [
    'accounts.google.co.jp',
    'accounts.google.co.uk',
    'accounts.google.de',
    'accounts.google.fr',
    'accounts.google.com.hk',
  ];

  for (const domain of domains) {
    try {
      await page.goto(`https://${domain}/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      const redirected = !finalUrl.includes(domain);
      logResult(`Domain-${domain}`, 'INFO', `Final: ${finalUrl.substring(0, 80)} | Redirected: ${redirected}`);
    } catch (e) {
      logResult(`Domain-${domain}`, 'FAIL', e.message.substring(0, 80));
    }
  }

  // ============================================================
  // 测试 6: Google Contacts / People API 侧信道
  // ============================================================
  console.log('\n📋 测试 6: People API / Contacts 侧信道');
  console.log('-'.repeat(40));

  const peopleResult = await page.evaluate(async () => {
    const results = {};
    // 尝试 People API 公开端点
    const urls = [
      'https://people.googleapis.com/v1/people:searchContacts?query=test@gmail.com&readMask=names,emailAddresses',
      'https://www.google.com/m8/feeds/contacts/default/full?q=test@gmail.com&alt=json',
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url);
        results[url.substring(0, 60)] = { status: r.status, body: (await r.text()).substring(0, 200) };
      } catch (e) {
        results[url.substring(0, 60)] = { error: e.message };
      }
    }
    return results;
  });

  for (const [url, res] of Object.entries(peopleResult)) {
    logResult(`People-${url.substring(0, 30)}`, res.error ? 'FAIL' : 'INFO', res.error || `HTTP ${res.status} | ${res.body}`);
  }

  // ============================================================
  // 测试 7: Gravatar 检测
  // ============================================================
  console.log('\n📋 测试 7: Gravatar 检测');
  console.log('-'.repeat(40));

  const gravatarResult = await page.evaluate(async () => {
    // MD5 hash 需要在浏览器中计算
    async function md5(str) {
      const encoder = new TextEncoder();
      const data = encoder.encode(str);
      const hash = await crypto.subtle.digest('SHA-256', data); // 注意：Gravatar 用 MD5，这里用 SHA-256 做近似测试
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    const results = {};
    const emails = ['test@gmail.com', 'dhjfkjshfk234hjkdhkh@gmail.com', '000001@gmail.com'];
    for (const email of emails) {
      const hash = await md5(email.trim().toLowerCase());
      const url = `https://www.gravatar.com/avatar/${hash}?d=404`;
      try {
        const r = await fetch(url, { method: 'HEAD' });
        results[email] = { status: r.status, hasAvatar: r.status === 200 };
      } catch (e) {
        results[email] = { error: e.message };
      }
    }
    return results;
  });

  for (const [email, res] of Object.entries(gravatarResult)) {
    logResult(`Gravatar-${email}`, res.error ? 'FAIL' : 'INFO', res.error || `HTTP ${res.status} | HasAvatar: ${res.hasAvatar}`);
  }

  // ============================================================
  // 测试 8: Google Profile 页面检测
  // ============================================================
  console.log('\n📋 测试 8: Google Profile 页面');
  console.log('-'.repeat(40));

  const profileUrls = [
    { name: 'aboutme-exist', url: 'https://aboutme.google.com/?hl=en' },
    { name: 'maps-contrib', url: 'https://www.google.com/maps/contrib/' },
  ];

  // 通过 Google 搜索检测用户是否存在
  const profileResult = await page.evaluate(async () => {
    const results = {};
    // 尝试 Google+ 遗留 URL
    const urls = [
      { name: 'plus-exist', url: 'https://plus.google.com/+test' },
      { name: 'profiles-exist', url: 'https://profiles.google.com/test' },
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u.url, { redirect: 'manual' });
        results[u.name] = { status: r.status, location: r.headers.get('location') || 'none' };
      } catch (e) {
        results[u.name] = { error: e.message };
      }
    }
    return results;
  });

  for (const [name, res] of Object.entries(profileResult)) {
    logResult(`Profile-${name}`, res.error ? 'FAIL' : 'INFO', res.error || `HTTP ${res.status} | Location: ${res.location}`);
  }

  // ============================================================
  // 测试 9: OAuth 发现 (login_hint)
  // ============================================================
  console.log('\n📋 测试 9: OAuth login_hint 检测');
  console.log('-'.repeat(40));

  // 使用一个公开的 OAuth client_id
  try {
    await page.goto('https://accounts.google.com/o/oauth2/v2/auth?client_id=407408718192.apps.googleusercontent.com&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=email&login_hint=dhjfkjshfk234hjkdhkh@gmail.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    const oauthUrl = page.url();
    const oauthText = await page.locator('body').innerText().catch(() => '');
    logResult('OAuth-nonexist', 'INFO', `URL: ${oauthUrl.substring(0, 80)} | Text: ${oauthText.substring(0, 100)}`);
  } catch (e) {
    logResult('OAuth-nonexist', 'FAIL', e.message.substring(0, 100));
  }

  try {
    await page.goto('https://accounts.google.com/o/oauth2/v2/auth?client_id=407408718192.apps.googleusercontent.com&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=email&login_hint=test@gmail.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    const oauthUrl2 = page.url();
    const oauthText2 = await page.locator('body').innerText().catch(() => '');
    logResult('OAuth-exist', 'INFO', `URL: ${oauthUrl2.substring(0, 80)} | Text: ${oauthText2.substring(0, 100)}`);
  } catch (e) {
    logResult('OAuth-exist', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 10: Cookie 导出 + 独立 HTTP 请求
  // ============================================================
  console.log('\n📋 测试 10: Cookie 导出可行性');
  console.log('-'.repeat(40));

  try {
    // 先走到注册用户名页面获取 session
    await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // 导出 cookies
    const cookies = await ctx.cookies();
    const cookieCount = cookies.length;
    const httpOnlyCookies = cookies.filter(c => c.httpOnly);
    const secureCookies = cookies.filter(c => c.secure);
    const googleCookies = cookies.filter(c => c.domain.includes('google'));

    logResult('Cookie-export', 'SUCCESS', `Total: ${cookieCount} | HttpOnly: ${httpOnlyCookies.length} | Secure: ${secureCookies.length} | Google: ${googleCookies.length}`);
    logResult('Cookie-names', 'INFO', googleCookies.map(c => c.name).join(', ').substring(0, 200));
  } catch (e) {
    logResult('Cookie-export', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 11: CDP 协议直接发请求
  // ============================================================
  console.log('\n📋 测试 11: CDP 协议');
  console.log('-'.repeat(40));

  try {
    const cdpSession = await ctx.newCDPSession(page);
    await cdpSession.send('Network.enable');
    logResult('CDP-session', 'SUCCESS', 'CDP session 创建成功，Network.enable 已启用');

    // 获取所有 cookies（包括 httpOnly）
    const cdpCookies = await cdpSession.send('Network.getAllCookies');
    logResult('CDP-cookies', 'SUCCESS', `通过 CDP 获取 ${cdpCookies.cookies.length} 个 cookies`);

    await cdpSession.detach();
  } catch (e) {
    logResult('CDP', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 12: 移动端 UA 注册流程
  // ============================================================
  console.log('\n📋 测试 12: 移动端 UA 注册');
  console.log('-'.repeat(40));

  try {
    const mobileCtx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915 },
      isMobile: true,
    });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await mobilePage.waitForTimeout(2000);
    const mobileUrl = mobilePage.url();
    const mobileText = await mobilePage.locator('body').innerText().catch(() => '');
    logResult('Mobile-signup', 'INFO', `URL: ${mobileUrl.substring(0, 80)} | HasName: ${mobileText.includes('姓名') || mobileText.includes('name')}`);
    await mobileCtx.close();
  } catch (e) {
    logResult('Mobile-signup', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 13: Google Workspace 注册入口
  // ============================================================
  console.log('\n📋 测试 13: Workspace 注册入口');
  console.log('-'.repeat(40));

  const workspaceUrls = [
    'https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp&service=wise',
    'https://workspace.google.com/signup',
    'https://accounts.google.com/signup?service=mail',
  ];

  for (const wUrl of workspaceUrls) {
    try {
      await page.goto(wUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(1500);
      logResult(`Workspace-${wUrl.substring(wUrl.lastIndexOf('/') + 1, wUrl.lastIndexOf('/') + 20)}`, 'INFO', `Final URL: ${page.url().substring(0, 80)}`);
    } catch (e) {
      logResult('Workspace', 'FAIL', e.message.substring(0, 80));
    }
  }

  // ============================================================
  // 测试 14: Google Chat / Hangouts 用户查找
  // ============================================================
  console.log('\n📋 测试 14: Google Chat/Hangouts');
  console.log('-'.repeat(40));

  const chatResult = await page.evaluate(async () => {
    const results = {};
    const urls = [
      { name: 'hangouts-people', url: 'https://people-pa.clients6.google.com/v2/people/lookup?key=AIzaSyAfpMnVHGBbfFOJOFnAMOGdCGz0LjVi3Ek' },
      { name: 'chat-api', url: 'https://chat.googleapis.com/v1/spaces' },
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u.url);
        results[u.name] = { status: r.status, body: (await r.text()).substring(0, 200) };
      } catch (e) {
        results[u.name] = { error: e.message };
      }
    }
    return results;
  });

  for (const [name, res] of Object.entries(chatResult)) {
    logResult(`Chat-${name}`, res.error ? 'FAIL' : 'INFO', res.error || `HTTP ${res.status} | ${res.body}`);
  }

  // ============================================================
  // 测试 15: GCP IAM / Cloud Identity
  // ============================================================
  console.log('\n📋 测试 15: GCP IAM / Cloud Identity');
  console.log('-'.repeat(40));

  const gcpResult = await page.evaluate(async () => {
    const results = {};
    const urls = [
      { name: 'cloudidentity', url: 'https://cloudidentity.googleapis.com/v1/users:lookup?key=test' },
      { name: 'admin-directory', url: 'https://admin.googleapis.com/admin/directory/v1/users?domain=gmail.com&query=test' },
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u.url);
        results[u.name] = { status: r.status, body: (await r.text()).substring(0, 200) };
      } catch (e) {
        results[u.name] = { error: e.message };
      }
    }
    return results;
  });

  for (const [name, res] of Object.entries(gcpResult)) {
    logResult(`GCP-${name}`, res.error ? 'FAIL' : 'INFO', res.error || `HTTP ${res.status} | ${res.body}`);
  }

  // ============================================================
  // 测试 16: SMTP RCPT TO (快速重测)
  // ============================================================
  console.log('\n📋 测试 16: SMTP RCPT TO (浏览器内不可测，跳过，已有结果)');
  console.log('-'.repeat(40));
  logResult('SMTP', 'INFO', '已在 test-smtp.js 中测试，结论：不可靠，Google 返回假阴性');

  // ============================================================
  // 测试 17: 邮件退信分析
  // ============================================================
  console.log('\n📋 测试 17: 邮件退信分析');
  console.log('-'.repeat(40));
  logResult('Bounce-analysis', 'INFO', '需要配置 SMTP 发送服务器，无法在浏览器内测试。原理：发送邮件到目标地址，等待 NDR 退信。速度极慢（分钟级），但独立通道。');

  // ============================================================
  // 测试 18: Google Calendar FreeBusy 查询
  // ============================================================
  console.log('\n📋 测试 18: Google Calendar FreeBusy');
  console.log('-'.repeat(40));

  const calResult = await page.evaluate(async () => {
    try {
      const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + 86400000).toISOString(),
          items: [{ id: 'test@gmail.com' }]
        })
      });
      return { status: r.status, body: (await r.text()).substring(0, 300) };
    } catch (e) {
      return { error: e.message };
    }
  });
  logResult('Calendar-FreeBusy', calResult.error ? 'FAIL' : 'INFO', calResult.error || `HTTP ${calResult.status} | ${calResult.body}`);

  // ============================================================
  // 测试 19: Google Drive API 共享检测 (无认证)
  // ============================================================
  console.log('\n📋 测试 19: Google Drive API (无认证)');
  console.log('-'.repeat(40));

  const driveResult = await page.evaluate(async () => {
    try {
      // 无认证测试 - 预期 401
      const r = await fetch('https://www.googleapis.com/drive/v3/files?q=name%3D%22test%22', {
        headers: { 'Authorization': 'Bearer invalid_token' }
      });
      return { status: r.status, body: (await r.text()).substring(0, 200) };
    } catch (e) {
      return { error: e.message };
    }
  });
  logResult('Drive-API', driveResult.error ? 'FAIL' : 'INFO', driveResult.error || `HTTP ${driveResult.status} | ${driveResult.body}`);
  logResult('Drive-sharing', 'INFO', '需要 OAuth token 才能测试共享检测。需要创建 GCP 项目 + OAuth 凭据。');

  // ============================================================
  // 测试 20: Google Groups 添加成员
  // ============================================================
  console.log('\n📋 测试 20: Google Groups');
  console.log('-'.repeat(40));

  const groupsResult = await page.evaluate(async () => {
    try {
      const r = await fetch('https://groups.google.com/');
      return { status: r.status, body: (await r.text()).substring(0, 200) };
    } catch (e) {
      return { error: e.message };
    }
  });
  logResult('Groups', groupsResult.error ? 'FAIL' : 'INFO', groupsResult.error || `HTTP ${groupsResult.status} | 需要登录才能添加成员测试`);

  // ============================================================
  // 测试 21: 多 context 并行可行性
  // ============================================================
  console.log('\n📋 测试 21: 多 context 并行');
  console.log('-'.repeat(40));

  try {
    const startTime = Date.now();
    const contexts = await Promise.all([
      browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0' }),
      browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0' }),
      browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118.0.0.0' }),
    ]);
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    
    // 并行打开注册页
    await Promise.all(pages.map(p => 
      p.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => e)
    ));
    
    const elapsed = Date.now() - startTime;
    const allLoaded = pages.every(p => p.url().includes('accounts.google'));
    logResult('MultiContext-3', allLoaded ? 'SUCCESS' : 'INFO', `3 contexts 并行加载: ${elapsed}ms | All loaded: ${allLoaded}`);
    
    // 清理
    for (const c of contexts) await c.close().catch(() => {});
  } catch (e) {
    logResult('MultiContext', 'FAIL', e.message.substring(0, 100));
  }

  // ============================================================
  // 测试 22: 第三方邮箱验证 API (免费额度)
  // ============================================================
  console.log('\n📋 测试 22: 第三方邮箱验证 API');
  console.log('-'.repeat(40));

  const thirdPartyResult = await page.evaluate(async () => {
    const results = {};
    // 一些有免费额度的验证 API
    const apis = [
      { name: 'emailrep', url: 'https://emailrep.io/test@gmail.com' },
      { name: 'disify', url: 'https://disify.com/api/email/test@gmail.com' },
    ];
    for (const api of apis) {
      try {
        const r = await fetch(api.url, { headers: { 'Accept': 'application/json' } });
        results[api.name] = { status: r.status, body: (await r.text()).substring(0, 300) };
      } catch (e) {
        results[api.name] = { error: e.message };
      }
    }
    return results;
  });

  for (const [name, res] of Object.entries(thirdPartyResult)) {
    logResult(`3rdParty-${name}`, res.error ? 'FAIL' : 'INFO', res.error || `HTTP ${res.status} | ${res.body}`);
  }

  // ============================================================
  // 汇总报告
  // ============================================================
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 全量测试汇总报告');
  console.log('='.repeat(60));

  const success = RESULTS.filter(r => r.status === 'SUCCESS');
  const fail = RESULTS.filter(r => r.status === 'FAIL');
  const info = RESULTS.filter(r => r.status === 'INFO');

  console.log(`\n✅ 成功/可行: ${success.length}`);
  for (const r of success) console.log(`   ${r.method}: ${r.detail}`);

  console.log(`\n❌ 失败/不可行: ${fail.length}`);
  for (const r of fail) console.log(`   ${r.method}: ${r.detail}`);

  console.log(`\n🔬 需进一步分析: ${info.length}`);
  for (const r of info) console.log(`   ${r.method}: ${r.detail}`);

  // 保存结果
  fs.writeFileSync('test-all-results.json', JSON.stringify(RESULTS, null, 2));
  console.log('\n📁 详细结果已保存到 test-all-results.json');

  await browser.close();
  console.log('\n🏁 全量测试完成');
}

main().catch(err => {
  console.error('致命错误:', err);
  fs.writeFileSync('test-all-results.json', JSON.stringify(RESULTS, null, 2));
  process.exit(1);
});
