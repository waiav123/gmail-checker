// Gmail 用户名检查器 - API 快速版
// 浏览器内 fetch 发请求，跳过 DOM 交互，速度快 10x+

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = __dirname;
const AVAILABLE_FILE = path.join(OUTPUT_DIR, 'available.txt');
const FAILED_FILE = path.join(OUTPUT_DIR, 'failed.txt');
const LOG_FILE = path.join(OUTPUT_DIR, 'checker-api.log');

let availableCount = 0, failedCount = 0;
const processed = new Set();
let allUsernames, inputFile;

function appendToFile(fp, line) { try { fs.appendFileSync(fp, line + '\n'); } catch {} }
function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch {}
}
function removeProcessedFromSource() {
  if (processed.size === 0) return;
  try {
    const remaining = allUsernames.filter(u => !processed.has(u));
    fs.writeFileSync(inputFile, remaining.join('\n'));
  } catch {}
}
function gracefulExit() {
  console.log('\n⚠️ 保存进度...');
  removeProcessedFromSource();
  console.log(`已处理 ${processed.size} 个 | ✅${availableCount} ❌${failedCount}`);
  process.exit(0);
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

// ==================== 浏览器内 API 调用 ====================

async function checkUsernameViaFetch(page, username, xsrfToken, sourcePath, fSid, dsh, blVersion, tlToken) {
  return await page.evaluate(async ({ username, xsrfToken, tlToken }) => {
    const innerData = `["${username}",1,0,null,[null,null,null,null,0,${Date.now() % 1000000}],0,40]`;
    const reqData = `[["NHJMOd",${JSON.stringify(innerData)},null,"generic"]]`;
    const body = `f.req=${encodeURIComponent(`[${reqData}]`)}&at=${encodeURIComponent(xsrfToken)}&`;

    // 最小必需参数：只需 rpcids + TL（调研确认其他参数均可选）
    const url = `/lifecycle/_/AccountLifecyclePlatformSignupUi/data/batchexecute?rpcids=NHJMOd&TL=${encodeURIComponent(tlToken)}&rt=c&_reqid=${Math.floor(Math.random() * 900000) + 100000}`;

    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=utf-8');
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () => reject(new Error('XHR network error'));
        xhr.timeout = 15000;
        xhr.ontimeout = () => reject(new Error('XHR timeout'));
        xhr.send(body);
      });

      if (result.status !== 200) return { status: 'error', reason: `HTTP ${result.status}`, debug: result.text.substring(0, 200) };

      const text = result.text;

      // 解析 batchexecute 响应，提取内部 JSON
      let inner = null;
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('[[')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed[0] && parsed[0][2]) inner = JSON.parse(parsed[0][2]);
          } catch {}
          break;
        }
      }

      if (!inner) return { status: 'error', reason: '响应解析失败', debug: text.substring(0, 200) };

      const flat = JSON.stringify(inner);

      // 精确分类（基于调研的完整响应格式）
      if (flat.includes('steps/signup/password')) return { status: 'available', reason: '可用' };
      if (inner[0] === null && inner[2] && Array.isArray(inner[2])) {
        const msg = inner[2][0] || '';
        if (msg.includes('长度') || msg.includes('between')) return { status: 'invalid', reason: '长度错误' };
        if (msg.includes('不允许') || msg.includes('not allowed')) return { status: 'invalid', reason: '不允许使用' };
        if (msg.includes('只能包含') || msg.includes('can only')) return { status: 'invalid', reason: '含非法字符' };
        return { status: 'invalid', reason: msg.substring(0, 30) };
      }
      if (inner[0] === null && Array.isArray(inner[1]) && inner[1].length > 0) return { status: 'taken', reason: '已被占用' };
      if (flat === '[null,[]]') return { status: 'degraded', reason: 'session可能降级' };
      if (flat.includes('请求过多') || flat.includes('Too many')) return { status: 'error', reason: '频率限制' };

      return { status: 'unknown', reason: '未知', debug: flat.substring(0, 200) };
    } catch (e) {
      return { status: 'error', reason: e.message.substring(0, 40) };
    }
  }, { username, xsrfToken, tlToken });
}


// ==================== 获取 Session 并到达用户名页面 ====================

async function setupSession(browser) {
  console.log('🚀 获取 session...');

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  let xsrfToken = '', sourcePath = '', fSid = '', blVersion = '', dsh = '', tlToken = '';

  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      const pd = req.postData() || '';
      const atMatch = pd.match(/at=([^&]+)/);
      if (atMatch) xsrfToken = decodeURIComponent(atMatch[1]);
      try {
        const u = new URL(req.url());
        sourcePath = u.searchParams.get('source-path') || sourcePath;
        fSid = u.searchParams.get('f.sid') || fSid;
        blVersion = u.searchParams.get('bl') || blVersion;
        tlToken = u.searchParams.get('TL') || tlToken;
      } catch {}
    }
  });

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
  } catch {}

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
  } catch {}

  // 处理用户名选择
  await page.waitForTimeout(2000);
  try {
    const radios = page.locator('[role="radio"], input[type="radio"]');
    if (await radios.count() > 0) {
      await radios.nth((await radios.count()) - 1).click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  // 做一次真实检查来触发 API 请求，然后留在用户名页面
  try {
    const input = page.locator('input[type="text"]:visible').first();
    await input.fill('sessiontest12345xyz');
    await page.waitForTimeout(300);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
    if (page.url().includes('/password')) {
      await page.goBack();
      await page.waitForTimeout(3000);
      // 确保回到用户名页面
      try {
        const r = page.locator('[role="radio"]');
        if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(800); }
      } catch {}
    }
  } catch {}

  // 确认当前页面 URL 包含 accounts.google.com
  const currentUrl = page.url();
  console.log(`   当前页面: ${currentUrl.substring(0, 80)}`);

  // 从页面提取 WIZ_global_data 中的 token（比请求拦截更可靠）
  try {
    const wizData = await page.evaluate(() => {
      const wiz = window.WIZ_global_data || {};
      return {
        xsrf: wiz['SNlM0e'] || '',
        fSid: wiz['FdrFJe'] || '',
        dsh: wiz['Qzxixc'] || '',
      };
    });
    if (wizData.xsrf) xsrfToken = wizData.xsrf;
    if (wizData.fSid) fSid = wizData.fSid;
    if (wizData.dsh) dsh = wizData.dsh;
  } catch {}

  // 从 URL 提取 TL token
  try {
    const u = new URL(currentUrl);
    tlToken = tlToken || u.searchParams.get('TL') || '';
  } catch {}

  // 从页面 HTML 提取 bl 版本号
  if (!blVersion) {
    try {
      blVersion = await page.evaluate(() => {
        const match = document.documentElement.innerHTML.match(/bl=([^&"']+)/);
        return match ? match[1] : '';
      });
    } catch {}
  }

  console.log(`   XSRF: ${xsrfToken.substring(0, 30)}...`);
  console.log(`   f.sid: ${fSid}`);
  console.log(`   dsh: ${dsh}`);
  console.log(`   bl: ${blVersion}`);
  console.log(`   TL: ${tlToken.substring(0, 30)}...`);

  return { page, ctx, xsrfToken, sourcePath: sourcePath || '/lifecycle/steps/signup/username', fSid, dsh, blVersion, tlToken };
}

// ==================== DOM 交互回退模式 ====================

async function checkUsernameDom(page, username) {
  try {
    const input = page.locator('input[type="text"]:visible').first();
    if (await input.count() === 0) return { status: 'error', reason: '找不到输入框' };

    await input.fill('');
    await page.waitForTimeout(50);
    await input.fill(username);
    await page.waitForTimeout(150);

    const beforeUrl = page.url();
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();

    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(300);
      if (page.url() !== beforeUrl) break;
      const t = await page.locator('main').innerText().catch(() => '');
      if (t.includes('已有人使用') || t.includes('is taken') ||
          t.includes('不允许使用') || t.includes('长度必须') || t.includes('只能包含')) break;
    }

    const url = page.url();
    if (url.includes('/password')) {
      await page.goBack();
      await page.waitForTimeout(1500);
      try {
        const r = page.locator('[role="radio"]');
        if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(500); }
      } catch {}
      return { status: 'available', reason: '可用' };
    }

    const text = await page.locator('main').innerText().catch(() => '');
    if (text.includes('已有人使用') || text.includes('is taken')) return { status: 'taken', reason: '已被占用' };
    if (text.includes('不允许使用') || text.includes('not allowed')) return { status: 'invalid', reason: '不允许使用' };
    if (text.includes('长度必须') || text.includes('between 6')) return { status: 'invalid', reason: '长度错误' };
    if (text.includes('只能包含') || text.includes('can only contain')) return { status: 'invalid', reason: '含非法字符' };
    if (text.includes('[null,[[')) return { status: 'taken', reason: '已被占用(有建议)' };

    return { status: 'unknown', reason: '未知状态' };
  } catch (e) {
    return { status: 'error', reason: e.message.split('\n')[0].substring(0, 40) };
  }
}

async function runDomMode(session, browser) {
  console.log('🔄 DOM 交互模式 (速度较慢但更可靠)\n');
  const { page } = session;
  const startTime = Date.now();
  let consecutiveErrors = 0;

  for (let i = 0; i < allUsernames.length; i++) {
    const username = allUsernames[i];
    const elapsed = (Date.now() - startTime) / 1000 || 1;
    const speed = (i + 1) / elapsed;
    const remaining = (allUsernames.length - i - 1) / speed;
    const eta = remaining > 60 ? `${(remaining / 60).toFixed(0)}m` : `${remaining.toFixed(0)}s`;
    const pct = ((i + 1) / allUsernames.length * 100).toFixed(1);

    process.stdout.write(`[${i+1}/${allUsernames.length} ${pct}% ${speed.toFixed(1)}/s ETA:${eta}] ${username}... `);

    const result = await checkUsernameDom(page, username);

    if (result.status !== 'error') {
      processed.add(username);
      if (result.status === 'available') {
        appendToFile(AVAILABLE_FILE, username);
        availableCount++;
        console.log('✅ 可用');
      } else {
        appendToFile(FAILED_FILE, `${username}\t${result.reason}`);
        failedCount++;
        console.log(`❌ ${result.reason}`);
      }
      consecutiveErrors = 0;
    } else {
      console.log(`⚠️ ${result.reason}`);
      consecutiveErrors++;
      if (consecutiveErrors <= 2) { i--; await page.waitForTimeout(2000); continue; }
      processed.add(username);
      appendToFile(FAILED_FILE, `${username}\t${result.reason}`);
      failedCount++;
      consecutiveErrors = 0;
    }

    if ((i + 1) % 10 === 0) removeProcessedFromSource();
    await page.waitForTimeout(500);
  }

  removeProcessedFromSource();
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(40));
  console.log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}  ⏱️ ${totalElapsed}s`);
}

// ==================== 主流程 ====================

async function main() {
  inputFile = process.argv[2] || path.join(__dirname, '..', 'all_numbers.txt');

  if (!fs.existsSync(inputFile)) { console.log(`❌ 文件不存在: ${inputFile}`); process.exit(1); }

  allUsernames = fs.readFileSync(inputFile, 'utf-8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

  if (allUsernames.length === 0) { console.log('✅ 全部完成'); process.exit(0); }

  if (fs.existsSync(AVAILABLE_FILE))
    availableCount = fs.readFileSync(AVAILABLE_FILE, 'utf-8').split('\n').filter(s => s.trim()).length;
  if (fs.existsSync(FAILED_FILE))
    failedCount = fs.readFileSync(FAILED_FILE, 'utf-8').split('\n').filter(s => s.trim()).length;

  console.log(`\n📧 Gmail 用户名检查器 (API 快速版)`);
  console.log(`📊 待检查: ${allUsernames.length}`);
  if (availableCount || failedCount) console.log(`📁 已有: ✅${availableCount} ❌${failedCount}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  let session = await setupSession(browser);

  if (!session.xsrfToken || !session.dsh) {
    console.log('❌ 未能获取必要的 session token');
    await browser.close();
    process.exit(1);
  }

  // 探针验证
  console.log('\n🔬 探针验证...');
  const probe = await checkUsernameViaFetch(session.page, 'dhjfkjshfk234hjkdhkh', session.xsrfToken, session.sourcePath, session.fSid, session.dsh, session.blVersion, session.tlToken);
  if (probe.status === 'available') {
    console.log('✅ API 工作正常\n');
  } else {
    console.log(`❌ 探针失败: ${probe.reason}`);
    if (probe.debug) console.log(`   Debug: ${probe.debug}`);
    // 回退到 DOM 模式 - 不退出，改用 DOM 交互
    console.log('   ⚠️ API 模式不可用，回退到 DOM 交互模式...\n');
    await runDomMode(session, browser);
    await browser.close();
    return;
  }

  console.log('🚀 开始批量检查...\n');
  const startTime = Date.now();
  let consecutiveErrors = 0;

  for (let i = 0; i < allUsernames.length; i++) {
    const username = allUsernames[i];
    const elapsed = (Date.now() - startTime) / 1000 || 1;
    const speed = (i + 1) / elapsed;
    const remaining = (allUsernames.length - i - 1) / speed;
    const eta = remaining > 60 ? `${(remaining / 60).toFixed(0)}m` : `${remaining.toFixed(0)}s`;
    const pct = ((i + 1) / allUsernames.length * 100).toFixed(1);

    process.stdout.write(`[${i+1}/${allUsernames.length} ${pct}% ${speed.toFixed(1)}/s ETA:${eta}] ${username}... `);

    const result = await checkUsernameViaFetch(session.page, username, session.xsrfToken, session.sourcePath, session.fSid, session.dsh, session.blVersion, session.tlToken);

    // 处理 session 降级（[null,[]] 响应）— 不立即刷新，先重试
    if (result.status === 'degraded') {
      consecutiveErrors++;
      log(`降级 #${consecutiveErrors}: ${username}`);
      if (consecutiveErrors <= 3) {
        console.log(`⚠️ 降级，等2s重试...`);
        await new Promise(r => setTimeout(r, 2000));
        i--; // 重试当前用户名
        continue;
      }
      // 连续 3 次降级才刷新 session
      console.log('\n⚠️ 连续降级，刷新 session...');
      try { await session.ctx.close(); } catch {}
      session = await setupSession(browser);
      consecutiveErrors = 0;
      i--;
      continue;
    }

    if (result.status !== 'error') {
      processed.add(username);
      if (result.status === 'available') {
        appendToFile(AVAILABLE_FILE, username);
        availableCount++;
        console.log('✅ 可用');
      } else {
        appendToFile(FAILED_FILE, `${username}\t${result.reason}`);
        failedCount++;
        console.log(`❌ ${result.reason}`);
      }
      consecutiveErrors = 0;
    } else {
      console.log(`⚠️ ${result.reason}`);
      consecutiveErrors++;
      log(`错误 #${consecutiveErrors}: ${username} -> ${result.reason}`);

      if (result.reason.includes('频率限制')) {
        console.log('   ⏳ 频率限制，等待 30s...');
        await new Promise(r => setTimeout(r, 30000));
        i--;
        continue;
      }
      if (consecutiveErrors >= 5) {
        console.log('\n⚠️ session 可能过期，重新获取...');
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser);
        consecutiveErrors = 0;
        i--;
        continue;
      }
      if (consecutiveErrors <= 2) {
        await new Promise(r => setTimeout(r, 1000));
        i--;
        continue;
      }
      processed.add(username);
      appendToFile(FAILED_FILE, `${username}\t重试失败:${result.reason}`);
      failedCount++;
    }

    if ((i + 1) % 10 === 0) removeProcessedFromSource();

    // 每 50 个探针校验（调研发现 500ms 间隔下 session 可用 80+ 次）
    if ((i + 1) % 50 === 0) {
      const p = await checkUsernameViaFetch(session.page, 'dhjfkjshfk234hjkdhkh', session.xsrfToken, session.sourcePath, session.fSid, session.dsh, session.blVersion, session.tlToken);
      if (p.status !== 'available') {
        console.log(`\n⚠️ 探针异常(${p.status}: ${p.reason})，刷新 session...`);
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser);
      }
    }

    // API 模式延迟 500ms（调研确认：速率是降级的主因，500ms 间隔可稳定 80+ 请求）
    await new Promise(r => setTimeout(r, 500));
  }

  removeProcessedFromSource();
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(40));
  console.log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}  ⏱️ ${totalElapsed}s`);

  await browser.close();
}

main().catch(err => {
  console.error('致命错误:', err);
  removeProcessedFromSource();
  process.exit(1);
});
