// Gmail 用户名检查器 - GitHub Actions 分布式版
// 专为 CI/CD 环境优化：headless、单 context、稳定优先
//
// 用法: node checker-distributed.js <输入文件> [输出目录]
// 例如: node checker-distributed.js batch-0.txt ./results

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const CONFIG = {
  REQUEST_DELAY: 350,         // 请求间隔 (ms) - 保守设置避免降级
  PROBE_INTERVAL: 50,         // 每 N 个请求做一次探针
  MAX_CONSECUTIVE_DEGRADE: 5, // 连续降级 N 次才刷新 session
  SESSION_REFRESH_ERRORS: 3,  // 连续错误 N 次刷新 session
  RATE_LIMIT_DELAY: 60000,    // 频率限制等待 (ms)
  SAVE_INTERVAL: 50,          // 每 N 个结果保存一次
  MAX_RETRIES: 3,             // 单个用户名最大重试次数
};

const PROBE_USERNAME = 'dhjfkjshfk234hjkdhkh';

// ==================== 文件路径 ====================
const inputFile = process.argv[2];
const outputDir = process.argv[3] || __dirname;
const AVAILABLE_FILE = path.join(outputDir, 'available.txt');
const FAILED_FILE = path.join(outputDir, 'failed.txt');
const PROGRESS_FILE = path.join(outputDir, 'progress.json');
const LOG_FILE = path.join(outputDir, 'checker.log');

// ==================== 全局状态 ====================
let availableCount = 0, failedCount = 0, totalChecked = 0;
const processed = new Set();
let allUsernames = [];
let isShuttingDown = false;
const startTime = Date.now();

// ==================== 工具函数 ====================

function appendToFile(fp, line) {
  try { fs.appendFileSync(fp, line + '\n'); } catch {}
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function saveProgress() {
  try {
    const progress = {
      totalChecked,
      availableCount,
      failedCount,
      processed: Array.from(processed),
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch {}
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      data.processed.forEach(u => processed.add(u));
      totalChecked = data.totalChecked || 0;
      availableCount = data.availableCount || 0;
      failedCount = data.failedCount || 0;
      log(`恢复进度: ${totalChecked} 已处理, ${availableCount} 可用, ${failedCount} 失败`);
    }
  } catch {}
}

function getStats() {
  const elapsed = (Date.now() - startTime) / 1000 || 1;
  const speed = totalChecked / elapsed;
  const remaining = allUsernames.length - totalChecked;
  const eta = remaining / (speed || 1);
  return { elapsed, speed, remaining, eta };
}

function gracefulExit() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('保存进度并退出...');
  saveProgress();
  const { speed } = getStats();
  log(`最终统计: ${totalChecked} 已处理 | ✅${availableCount} ❌${failedCount} | ${speed.toFixed(2)}/s`);
  process.exit(0);
}

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

// ==================== API 检查函数 ====================

async function checkUsernameAPI(page, username, xsrfToken, tlToken) {
  return await page.evaluate(async ({ username, xsrfToken, tlToken }) => {
    const innerData = `["${username}",1,0,null,[null,null,null,null,0,${Date.now() % 1000000}],0,40]`;
    const reqData = `[["NHJMOd",${JSON.stringify(innerData)},null,"generic"]]`;
    const body = `f.req=${encodeURIComponent(`[${reqData}]`)}&at=${encodeURIComponent(xsrfToken)}&`;
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

      if (result.status !== 200) return { status: 'error', reason: `HTTP ${result.status}` };

      let inner = null;
      const lines = result.text.split('\n');
      for (const line of lines) {
        if (line.startsWith('[[')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed[0] && parsed[0][2]) inner = JSON.parse(parsed[0][2]);
          } catch {}
          break;
        }
      }

      if (!inner) return { status: 'error', reason: '响应解析失败' };

      const flat = JSON.stringify(inner);
      if (flat.includes('steps/signup/password')) return { status: 'available' };
      if (inner[0] === null && inner[2] && Array.isArray(inner[2])) return { status: 'invalid', reason: (inner[2][0] || '').substring(0, 30) };
      if (inner[0] === null && Array.isArray(inner[1]) && inner[1].length > 0) return { status: 'taken' };
      if (flat === '[null,[]]') return { status: 'degraded' };
      if (flat.includes('请求过多') || flat.includes('Too many')) return { status: 'ratelimit' };
      return { status: 'unknown', reason: flat.substring(0, 80) };
    } catch (e) {
      return { status: 'error', reason: e.message.substring(0, 40) };
    }
  }, { username, xsrfToken, tlToken });
}

// ==================== Session 建立 ====================

async function setupSession(browser) {
  log('建立 session...');
  const setupStart = Date.now();

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

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

  // 打开注册页
  await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // 填名字
  try {
    const ni = page.locator('input[type="text"]:visible');
    if (await ni.count() >= 2) { await ni.nth(0).fill('Test'); await ni.nth(1).fill('User'); }
    else if (await ni.count() >= 1) { await ni.nth(0).fill('Test'); }
    await page.waitForTimeout(500);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
  } catch (e) { log(`填名字失败: ${e.message}`); }

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
  } catch (e) { log(`填生日失败: ${e.message}`); }

  // 选自定义用户名
  await page.waitForTimeout(2000);
  try {
    const radios = page.locator('[role="radio"], input[type="radio"]');
    if (await radios.count() > 0) {
      await radios.nth((await radios.count()) - 1).click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  // 触发一次 API 请求来获取 tokens
  try {
    const input = page.locator('input[type="text"]:visible').first();
    await input.fill(`sessioninit${Date.now() % 10000}`);
    await page.waitForTimeout(300);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(4000);
    if (page.url().includes('/password')) {
      await page.goBack();
      await page.waitForTimeout(3000);
      try {
        const r = page.locator('[role="radio"]');
        if (await r.count() > 0) { await r.nth((await r.count())-1).click(); await page.waitForTimeout(500); }
      } catch {}
    }
  } catch {}

  // 从页面提取 tokens
  try {
    const wizData = await page.evaluate(() => {
      const wiz = window.WIZ_global_data || {};
      return { xsrf: wiz['SNlM0e'] || '', fSid: wiz['FdrFJe'] || '', dsh: wiz['Qzxixc'] || '' };
    });
    if (wizData.xsrf) xsrfToken = wizData.xsrf;
  } catch {}

  // 从 URL 提取 TL
  try {
    const u = new URL(page.url());
    tlToken = tlToken || u.searchParams.get('TL') || '';
  } catch {}

  const setupTime = ((Date.now() - setupStart) / 1000).toFixed(1);
  const ok = !!(xsrfToken && tlToken);
  log(`Session ${ok ? '✅' : '❌'} ${setupTime}s | XSRF: ${xsrfToken.substring(0, 15)}... | TL: ${tlToken.substring(0, 15)}...`);

  return { page, ctx, xsrfToken, tlToken, ok };
}

// ==================== 主流程 ====================

async function main() {
  if (!inputFile || !fs.existsSync(inputFile)) {
    console.log(`用法: node checker-distributed.js <输入文件> [输出目录]`);
    console.log(`错误: 输入文件不存在: ${inputFile}`);
    process.exit(1);
  }

  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 加载进度
  loadProgress();

  // 读取用户名
  allUsernames = fs.readFileSync(inputFile, 'utf-8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#') && !processed.has(s));

  if (allUsernames.length === 0) {
    log('✅ 全部完成');
    process.exit(0);
  }

  log(`📧 Gmail 检查器 (分布式版)`);
  log(`📊 待检查: ${allUsernames.length} | 间隔: ${CONFIG.REQUEST_DELAY}ms`);
  log(`📁 输出目录: ${outputDir}`);

  const browser = await chromium.launch({
    headless: true,  // CI 环境必须 headless
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });

  let session = await setupSession(browser);
  if (!session.ok) {
    log('❌ Session 建立失败');
    await browser.close();
    process.exit(1);
  }

  // 探针验证
  const probe = await checkUsernameAPI(session.page, PROBE_USERNAME, session.xsrfToken, session.tlToken);
  if (probe.status !== 'available') {
    log(`❌ 探针失败: ${probe.status} ${probe.reason || ''}`);
    await browser.close();
    process.exit(1);
  }
  log('✅ 探针通过，开始检查...');

  let consecutiveErrors = 0;
  let degradeCount = 0;
  let requestCount = 0;

  for (let i = 0; i < allUsernames.length && !isShuttingDown; i++) {
    const username = allUsernames[i];
    let retries = 0;
    let result;

    while (retries < CONFIG.MAX_RETRIES) {
      // 探针检测
      if (requestCount > 0 && requestCount % CONFIG.PROBE_INTERVAL === 0) {
        const probeResult = await checkUsernameAPI(session.page, PROBE_USERNAME, session.xsrfToken, session.tlToken);
        if (probeResult.status !== 'available') {
          log(`⚠️ 探针异常，刷新 session...`);
          try { await session.ctx.close(); } catch {}
          session = await setupSession(browser);
          if (!session.ok) {
            log('❌ Session 刷新失败');
            saveProgress();
            await browser.close();
            process.exit(1);
          }
          degradeCount = 0;
        }
      }

      await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
      result = await checkUsernameAPI(session.page, username, session.xsrfToken, session.tlToken);
      requestCount++;

      if (result.status === 'degraded') {
        degradeCount++;
        retries++;
        const delay = 2000 + degradeCount * 1000;
        log(`降级 #${degradeCount}: ${username}, 等待 ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));

        if (degradeCount >= CONFIG.MAX_CONSECUTIVE_DEGRADE) {
          log('⚠️ 连续降级过多，刷新 session...');
          try { await session.ctx.close(); } catch {}
          session = await setupSession(browser);
          if (!session.ok) break;
          degradeCount = 0;
        }
        continue;
      }

      if (result.status === 'ratelimit') {
        log(`⏳ 频率限制: ${username}, 等待 ${CONFIG.RATE_LIMIT_DELAY/1000}s`);
        await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_DELAY));
        retries++;
        continue;
      }

      if (result.status === 'error') {
        consecutiveErrors++;
        retries++;
        log(`错误 #${consecutiveErrors}: ${username} -> ${result.reason}`);
        if (consecutiveErrors >= CONFIG.SESSION_REFRESH_ERRORS) {
          log('⚠️ 连续错误过多，刷新 session...');
          try { await session.ctx.close(); } catch {}
          session = await setupSession(browser);
          if (!session.ok) break;
          consecutiveErrors = 0;
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // 成功获取结果
      break;
    }

    if (!session.ok) {
      log('❌ Session 不可用，退出');
      break;
    }

    // 记录结果
    processed.add(username);
    totalChecked++;
    degradeCount = 0;
    consecutiveErrors = 0;

    if (result.status === 'available') {
      appendToFile(AVAILABLE_FILE, username);
      availableCount++;
      log(`✅ ${username} — 可用!`);
    } else {
      appendToFile(FAILED_FILE, `${username}\t${result.status}${result.reason ? ':' + result.reason : ''}`);
      failedCount++;
    }

    // 定期保存和报告
    if (totalChecked % CONFIG.SAVE_INTERVAL === 0) {
      saveProgress();
      const { speed, remaining, eta } = getStats();
      const etaStr = eta > 3600 ? `${(eta/3600).toFixed(1)}h` : `${(eta/60).toFixed(0)}m`;
      log(`📊 ${totalChecked}/${allUsernames.length} | ${speed.toFixed(2)}/s | ✅${availableCount} ❌${failedCount} | ETA: ${etaStr}`);
    }
  }

  // 最终保存
  saveProgress();

  const { elapsed, speed } = getStats();
  log('='.repeat(50));
  log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}  📊 总计: ${totalChecked}`);
  log(`⏱️ ${elapsed.toFixed(0)}s | ${speed.toFixed(2)} req/s`);
  log('='.repeat(50));

  await browser.close();
}

main().catch(err => {
  log(`致命错误: ${err.message}`);
  saveProgress();
  process.exit(1);
});
