// Gmail 用户名检查器 - GitHub Actions 分布式版 (多 Context 并发)
// 每个 job 内跑多个 context 提高单 IP 效率
//
// 用法: node checker-distributed.js <输入文件> [输出目录] [context数量]
// 例如: node checker-distributed.js batch-0.txt ./results 3

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const CONFIG = {
  CONTEXT_COUNT: parseInt(process.env.CONTEXT_COUNT) || parseInt(process.argv[4]) || 3,
  REQUEST_DELAY: parseInt(process.env.REQUEST_DELAY) || 500,
  GLOBAL_MAX_RPS: parseFloat(process.env.MAX_RPS) || 3.5,
  PROBE_INTERVAL: 60,
  MAX_CONSECUTIVE_DEGRADE: 6,
  SESSION_REFRESH_ERRORS: 4,
  RATE_LIMIT_DELAY: 60000,
  SAVE_INTERVAL: 50,
  MAX_RETRIES: 3,
  WORKER_STAGGER_DELAY: 800,
};

const PROBE_USERNAME = 'dhjfkjshfk234hjkdhkh';

// ==================== 文件路径 ====================
const inputFile = process.argv[2];
const outputDir = process.argv[3] || __dirname;
const AVAILABLE_FILE = path.join(outputDir, 'available.txt');
const FAILED_FILE = path.join(outputDir, 'failed.txt');
const DEGRADED_FILE = path.join(outputDir, 'degraded.txt');
const PROGRESS_FILE = path.join(outputDir, 'progress.json');
const LOG_FILE = path.join(outputDir, 'checker.log');

// ==================== 全局状态 ====================
let availableCount = 0, failedCount = 0, degradedCount = 0, totalChecked = 0;
let originalTotal = 0;
const processed = new Set();
let allUsernames = [];
let isShuttingDown = false;
const startTime = Date.now();

// ==================== 全局速率限制器 ====================
class GlobalRateLimiter {
  constructor(maxRps) {
    this.minInterval = 1000 / maxRps;
    this.lastRequest = 0;
    this.currentMinInterval = this.minInterval;
    this.recentDegrades = 0;
    this.recentSuccesses = 0;
  }
  async acquire() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.currentMinInterval) {
      await new Promise(r => setTimeout(r, this.currentMinInterval - elapsed));
    }
    this.lastRequest = Date.now();
  }
  onDegrade() {
    this.recentDegrades++;
    this.recentSuccesses = 0;
    if (this.recentDegrades > 2) {
      this.currentMinInterval = Math.min(this.currentMinInterval * 1.05, this.minInterval * 2.5);
    }
  }
  onSuccess() {
    this.recentSuccesses++;
    if (this.recentSuccesses > 3) {
      this.recentDegrades = 0;
      this.currentMinInterval = Math.max(this.currentMinInterval * 0.95, this.minInterval);
    }
  }
  getEffectiveRps() { return (1000 / this.currentMinInterval).toFixed(1); }
}

const rateLimiter = new GlobalRateLimiter(CONFIG.GLOBAL_MAX_RPS);

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
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
      totalChecked, availableCount, failedCount, degradedCount, originalTotal,
      processed: Array.from(processed),
      timestamp: new Date().toISOString()
    }, null, 2));
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
      degradedCount = data.degradedCount || 0;
      originalTotal = data.originalTotal || 0;
      log(`恢复进度: ${totalChecked} 已处理, ${availableCount} 可用, ${failedCount} 失败, ${degradedCount} 降级`);
    }
  } catch {}
}

function getStats() {
  const elapsed = (Date.now() - startTime) / 1000 || 1;
  const speed = totalChecked / elapsed;
  const total = originalTotal || allUsernames.length;
  const remaining = total - totalChecked;
  const eta = remaining / (speed || 1);
  return { elapsed, speed, remaining, eta, total };
}

function gracefulExit() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('保存进度并退出...');
  saveProgress();
  const { speed } = getStats();
  log(`最终统计: ${totalChecked} 已处理 | ✅${availableCount} ❌${failedCount} ⚠️${degradedCount} | ${speed.toFixed(2)}/s`);
  process.exit(0);
}

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

// ==================== API 检查函数 ====================
async function checkUsernameAPI(page, username, xsrfToken, tlToken, debug = false) {
  return await page.evaluate(async ({ username, xsrfToken, tlToken, debug }) => {
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
      if (result.status !== 200) return { status: 'error', reason: `HTTP ${result.status}`, raw: debug ? result.text.substring(0, 500) : undefined };
      let inner = null;
      const lines = result.text.split('\n');
      for (const line of lines) {
        if (line.startsWith('[[')) {
          try { const parsed = JSON.parse(line); if (parsed[0] && parsed[0][2]) inner = JSON.parse(parsed[0][2]); } catch {}
          break;
        }
      }
      if (!inner) return { status: 'error', reason: '响应解析失败', raw: debug ? result.text.substring(0, 500) : undefined };
      const flat = JSON.stringify(inner);
      if (flat.includes('steps/signup/password')) return { status: 'available' };
      if (inner[0] === null && inner[2] && Array.isArray(inner[2])) return { status: 'invalid', reason: (inner[2][0] || '').substring(0, 30) };
      if (inner[0] === null && Array.isArray(inner[1]) && inner[1].length > 0) return { status: 'taken' };
      if (flat === '[null,[]]') return { status: 'degraded' };
      if (flat.includes('请求过多') || flat.includes('Too many')) return { status: 'ratelimit' };
      return { status: 'unknown', reason: flat.substring(0, 80) };
    } catch (e) { return { status: 'error', reason: e.message.substring(0, 40) }; }
  }, { username, xsrfToken, tlToken, debug });
}

// ==================== Session 建立 (CI/CD 优化) ====================
async function setupSession(browser, id) {
  const label = `[S${id}]`;
  log(`${label} 建立 session...`);
  const setupStart = Date.now();

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  let xsrfToken = '', tlToken = '';
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      const pd = req.postData() || '';
      const atMatch = pd.match(/at=([^&]+)/);
      if (atMatch) xsrfToken = decodeURIComponent(atMatch[1]);
      try { const u = new URL(req.url()); tlToken = u.searchParams.get('TL') || tlToken; } catch {}
    }
  });

  async function clickNext() {
    await page.locator('button:has-text("Next"), button:has-text("下一步")').first().click();
  }

  // Step 1: 打开注册页
  await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp&hl=en',
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Step 2: 填名字
  try {
    const nameInputs = page.locator('input[type="text"]:visible');
    const count = await nameInputs.count();
    if (count >= 2) { await nameInputs.nth(0).fill('Test'); await nameInputs.nth(1).fill('User'); }
    else if (count >= 1) { await nameInputs.nth(0).fill('Test User'); }
    await page.waitForTimeout(500);
    await clickNext();
    await page.waitForTimeout(4000);
  } catch (e) { log(`${label} 填名字失败: ${e.message}`); }

  // Step 3: 填生日和性别
  const currentUrl = page.url();
  if (currentUrl.includes('birthday') || currentUrl.includes('birthdaygender')) {
    log(`${label} 检测到生日页面`);
    try {
      await page.waitForSelector('input', { timeout: 10000 });
      const inputs = page.locator('input:visible');
      const comboboxes = page.locator('[role="combobox"]:visible, select:visible');
      const inputCount = await inputs.count();
      const comboCount = await comboboxes.count();

      if (comboCount > 0) {
        await comboboxes.nth(0).click(); await page.waitForTimeout(500);
        const options = page.locator('[role="option"]:visible, option:visible');
        if (await options.count() > 0) { await options.nth(1).click(); await page.waitForTimeout(300); }
      }
      const dayInput = page.locator('input[aria-label*="Day" i], input[aria-label*="日" i]').first();
      if (await dayInput.count() > 0) await dayInput.fill('15');
      else if (inputCount > 0) await inputs.nth(0).fill('15');
      await page.waitForTimeout(200);

      const yearInput = page.locator('input[aria-label*="Year" i], input[aria-label*="年" i]').first();
      if (await yearInput.count() > 0) await yearInput.fill('1990');
      else if (inputCount > 1) await inputs.nth(inputCount - 1).fill('1990');
      await page.waitForTimeout(200);

      if (comboCount > 1) {
        await comboboxes.nth(1).click(); await page.waitForTimeout(500);
        const genderOptions = page.locator('[role="option"]:visible');
        if (await genderOptions.count() > 1) { await genderOptions.nth(1).click(); await page.waitForTimeout(300); }
      }
      await page.waitForTimeout(500);
      await clickNext();
      await page.waitForTimeout(5000);
    } catch (e) { log(`${label} 填生日失败: ${e.message}`); }
  }

  // Step 4: 选自定义用户名
  await page.waitForTimeout(2000);
  try {
    const radios = page.locator('[role="radio"]');
    if (await radios.count() > 0) {
      await radios.nth((await radios.count()) - 1).click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Step 5: 触发 API 获取 tokens
  try {
    const usernameInput = page.locator('input[type="text"]:visible').first();
    if (await usernameInput.count() > 0) {
      await usernameInput.fill(`testinit${id}${Date.now() % 100000}`);
      await page.waitForTimeout(500);
      await clickNext();
      await page.waitForTimeout(4000);
      if (page.url().includes('/password')) {
        await page.goBack(); await page.waitForTimeout(3000);
        try { const r = page.locator('[role="radio"]'); if (await r.count() > 0) { await r.nth((await r.count()) - 1).click(); await page.waitForTimeout(500); } } catch {}
      }
    }
  } catch (e) { log(`${label} 触发 token 失败: ${e.message}`); }

  try {
    const wizData = await page.evaluate(() => { const wiz = window.WIZ_global_data || {}; return { xsrf: wiz['SNlM0e'] || '' }; });
    if (wizData.xsrf) xsrfToken = wizData.xsrf;
  } catch {}
  try { const u = new URL(page.url()); tlToken = tlToken || u.searchParams.get('TL') || ''; } catch {}

  const setupTime = ((Date.now() - setupStart) / 1000).toFixed(1);
  const ok = !!(xsrfToken && tlToken);
  log(`${label} Session ${ok ? '✅' : '❌'} ${setupTime}s | XSRF: ${xsrfToken.substring(0, 15)}... | TL: ${tlToken.substring(0, 15)}...`);
  return { id, page, ctx, xsrfToken, tlToken, requestCount: 0, degradeCount: 0, ok };
}

// ==================== Worker：每个 context 的工作循环 ====================
async function worker(session, browser, getNextUsername) {
  const label = `[W${session.id}]`;
  let consecutiveErrors = 0;
  let retryUsername = null;

  while (!isShuttingDown) {
    const username = retryUsername || getNextUsername();
    retryUsername = null;
    if (!username) break;

    // 探针检测
    if (session.requestCount > 0 && session.requestCount % CONFIG.PROBE_INTERVAL === 0) {
      const probe = await checkUsernameAPI(session.page, PROBE_USERNAME, session.xsrfToken, session.tlToken);
      if (probe.status !== 'available') {
        log(`${label} ⚠️ 探针异常，刷新 session...`);
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser, session.id);
        if (!session.ok) { log(`${label} Session 刷新失败`); break; }
        session.degradeCount = 0;
      }
    }

    await rateLimiter.acquire();
    const result = await checkUsernameAPI(session.page, username, session.xsrfToken, session.tlToken);
    session.requestCount++;

    // 降级处理
    if (result.status === 'degraded') {
      session.degradeCount++;
      rateLimiter.onDegrade();
      const backoffMs = Math.min(2000 + (session.degradeCount - 1) * 1000, 6000);
      log(`${label} 降级 #${session.degradeCount}: ${username}, 等待 ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));

      if (session.degradeCount <= CONFIG.MAX_RETRIES) {
        retryUsername = username;
        continue;
      }
      if (session.degradeCount >= CONFIG.MAX_CONSECUTIVE_DEGRADE) {
        log(`${label} ⚠️ 连续降级 ${session.degradeCount} 次，刷新 session...`);
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser, session.id);
        session.degradeCount = 0;
        if (!session.ok) break;
        retryUsername = username;
        continue;
      }
      // 超过重试次数但未到刷新阈值，记为降级
      processed.add(username);
      totalChecked++;
      appendToFile(DEGRADED_FILE, username);
      degradedCount++;
      log(`${label} ⚠️ ${username} — 降级未确认`);
      continue;
    }

    session.degradeCount = 0;
    rateLimiter.onSuccess();

    // 频率限制
    if (result.status === 'ratelimit') {
      log(`${label} ⏳ 频率限制: ${username}, 等待 ${CONFIG.RATE_LIMIT_DELAY/1000}s`);
      await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_DELAY));
      retryUsername = username;
      continue;
    }

    // 错误处理
    if (result.status === 'error') {
      consecutiveErrors++;
      log(`${label} 错误 #${consecutiveErrors}: ${username} -> ${result.reason}`);
      if (consecutiveErrors >= CONFIG.SESSION_REFRESH_ERRORS) {
        log(`${label} ⚠️ 连续错误过多，刷新 session...`);
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser, session.id);
        consecutiveErrors = 0;
        if (!session.ok) break;
        retryUsername = username;
        continue;
      }
      if (consecutiveErrors <= 2) { await new Promise(r => setTimeout(r, 2000)); retryUsername = username; continue; }
      // 放弃
      processed.add(username);
      totalChecked++;
      appendToFile(FAILED_FILE, `${username}\terror:${result.reason}`);
      failedCount++;
      consecutiveErrors = 0;
      continue;
    }

    consecutiveErrors = 0;
    processed.add(username);
    totalChecked++;

    if (result.status === 'available') {
      appendToFile(AVAILABLE_FILE, username);
      availableCount++;
      log(`${label} ✅ ${username} — 可用!`);
    } else {
      appendToFile(FAILED_FILE, `${username}\t${result.status}${result.reason ? ':' + result.reason : ''}`);
      failedCount++;
      log(`${label} ❌ ${username} — ${result.status}${result.reason ? ': ' + result.reason : ''}`);
    }

    if (totalChecked % CONFIG.SAVE_INTERVAL === 0) {
      saveProgress();
      const { speed, eta, total } = getStats();
      const etaStr = eta > 3600 ? `${(eta/3600).toFixed(1)}h` : `${(eta/60).toFixed(0)}m`;
      log(`📊 ${totalChecked}/${total} | ${speed.toFixed(2)}/s [cap:${rateLimiter.getEffectiveRps()}] | ✅${availableCount} ❌${failedCount} ⚠️${degradedCount} | ETA: ${etaStr}`);
    }
  }
  return session;
}

// ==================== 主流程 ====================
async function main() {
  if (!inputFile || !fs.existsSync(inputFile)) {
    console.log(`用法: node checker-distributed.js <输入文件> [输出目录] [context数量]`);
    process.exit(1);
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  loadProgress();

  const allRaw = fs.readFileSync(inputFile, 'utf-8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (!originalTotal) originalTotal = allRaw.length + processed.size;
  allUsernames = allRaw.filter(s => !processed.has(s));

  if (allUsernames.length === 0) { log('✅ 全部完成'); process.exit(0); }

  log(`📧 Gmail 检查器 (分布式多Context版)`);
  log(`📊 待检查: ${allUsernames.length} | ${CONFIG.CONTEXT_COUNT} context | 限速: ${CONFIG.GLOBAL_MAX_RPS} req/s`);
  log(`📁 输出目录: ${outputDir}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  // 建立多个 session
  log(`🚀 建立 ${CONFIG.CONTEXT_COUNT} 个 session...`);
  const sessions = [];
  for (let i = 0; i < CONFIG.CONTEXT_COUNT; i++) {
    try {
      const s = await setupSession(browser, i);
      if (s.ok) {
        const probe = await checkUsernameAPI(s.page, PROBE_USERNAME, s.xsrfToken, s.tlToken, true);
        if (probe.status === 'available') {
          sessions.push(s);
          log(`[S${i}] ✅ 探针通过`);
        } else {
          log(`[S${i}] ❌ 探针失败: ${JSON.stringify(probe)}`);
          try { await s.ctx.close(); } catch {}
        }
      }
    } catch (e) { log(`[S${i}] ❌ 建立失败: ${e.message.substring(0, 80)}`); }
  }

  if (sessions.length === 0) {
    log('❌ 没有可用的 session，退出');
    await browser.close();
    process.exit(1);
  }

  log(`✅ ${sessions.length}/${CONFIG.CONTEXT_COUNT} 个 session 就绪，开始检查...`);

  // 用户名分配器
  let usernameIndex = 0;
  function getNextUsername() {
    while (usernameIndex < allUsernames.length) {
      const u = allUsernames[usernameIndex++];
      if (!processed.has(u)) return u;
    }
    return null;
  }

  // 启动所有 worker 并行（错开启动）
  const workerPromises = sessions.map((s, idx) =>
    new Promise(resolve => setTimeout(() => resolve(worker(s, browser, getNextUsername)), idx * CONFIG.WORKER_STAGGER_DELAY))
  );
  await Promise.all(workerPromises);

  saveProgress();
  const { elapsed, speed } = getStats();
  log('='.repeat(50));
  log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}  ⚠️ 降级: ${degradedCount}  📊 总计: ${totalChecked}`);
  log(`⏱️ ${elapsed.toFixed(0)}s | ${speed.toFixed(2)} req/s | ${sessions.length} contexts`);
  log('='.repeat(50));

  await browser.close();
}

main().catch(err => { log(`致命错误: ${err.message}`); saveProgress(); process.exit(1); });
