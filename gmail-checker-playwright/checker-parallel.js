// Gmail 用户名检查器 - 多 Context 并行版
// 基于调研 v3 数据：2 context + 200ms 间隔 = 4.3 req/s 零降级
// 目标：3 context + 250ms 间隔 ≈ 6 req/s
//
// 用法: node checker-parallel.js [输入文件] [context数量]
// 例如: node checker-parallel.js ../all_numbers.txt 3

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const CONFIG = {
  CONTEXT_COUNT: parseInt(process.argv[3]) || 2,  // 默认 2 context（单 IP 最优）
  GLOBAL_MAX_RPS: 4.0,     // 全局最大请求速率 (req/s)
  PROBE_INTERVAL: 80,       // 每 N 个请求做一次探针
  MAX_CONSECUTIVE_DEGRADE: 8, // 连续降级 N 次才刷新 session
  DEGRADE_BASE_DELAY: 1500,   // 降级重试基础等待 (ms)
  SESSION_REFRESH_ERRORS: 5,  // 连续错误 N 次刷新 session
  RATE_LIMIT_DELAY: 30000,    // 频率限制等待 (ms)
  SAVE_INTERVAL: 20,          // 每 N 个结果保存一次进度
  WORKER_STAGGER_DELAY: 500,  // worker 启动错开间隔 (ms)
};

const PROBE_USERNAME = 'dhjfkjshfk234hjkdhkh'; // 已知可用的探针

// ==================== 文件路径 ====================
const OUTPUT_DIR = __dirname;
const AVAILABLE_FILE = path.join(OUTPUT_DIR, 'available.txt');
const FAILED_FILE = path.join(OUTPUT_DIR, 'failed.txt');
const LOG_FILE = path.join(OUTPUT_DIR, 'checker-parallel.log');

// ==================== 全局状态 ====================
let availableCount = 0, failedCount = 0, totalChecked = 0;
const processed = new Set();
let allUsernames = [], inputFile;
let isShuttingDown = false;
const startTime = Date.now();

// ==================== 全局速率限制器 ====================
// 所有 worker 共享，确保总请求速率不超过阈值
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
    // 温和减速：每次降级增加 5%，最多 2x
    if (this.recentDegrades > 2) {
      this.currentMinInterval = Math.min(this.currentMinInterval * 1.05, this.minInterval * 2);
    }
  }

  onSuccess() {
    this.recentSuccesses++;
    if (this.recentSuccesses > 3) {
      this.recentDegrades = 0;
      // 快速恢复：连续成功 3 次就恢复 5%
      this.currentMinInterval = Math.max(this.currentMinInterval * 0.95, this.minInterval);
    }
  }

  getEffectiveRps() {
    return (1000 / this.currentMinInterval).toFixed(1);
  }
}

const rateLimiter = new GlobalRateLimiter(CONFIG.GLOBAL_MAX_RPS);


// ==================== 工具函数 ====================

function appendToFile(fp, line) {
  try { fs.appendFileSync(fp, line + '\n'); } catch {}
}

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  const line = `[${ts}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function saveProgress() {
  if (processed.size === 0) return;
  try {
    const remaining = allUsernames.filter(u => !processed.has(u));
    fs.writeFileSync(inputFile, remaining.join('\n'));
  } catch {}
}

function getStats() {
  const elapsed = (Date.now() - startTime) / 1000 || 1;
  const speed = totalChecked / elapsed;
  const remaining = allUsernames.length - totalChecked;
  const eta = remaining / (speed || 1);
  const etaStr = eta > 3600 ? `${(eta/3600).toFixed(1)}h` : eta > 60 ? `${(eta/60).toFixed(0)}m` : `${eta.toFixed(0)}s`;
  const pct = (totalChecked / allUsernames.length * 100).toFixed(1);
  return { elapsed, speed, remaining, etaStr, pct };
}

function gracefulExit() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n⚠️ 保存进度...');
  saveProgress();
  const { speed } = getStats();
  console.log(`已处理 ${totalChecked} 个 | ✅${availableCount} ❌${failedCount} | ${speed.toFixed(1)}/s`);
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

async function setupSession(browser, id) {
  const label = `[S${id}]`;
  console.log(`${label} 建立 session...`);
  const setupStart = Date.now();

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

  // 打开注册页
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
  await page.waitForTimeout(1500);
  try {
    const radios = page.locator('[role="radio"], input[type="radio"]');
    if (await radios.count() > 0) {
      await radios.nth((await radios.count()) - 1).click();
      await page.waitForTimeout(800);
    }
  } catch {}

  // 触发一次 API 请求来获取 tokens
  try {
    const input = page.locator('input[type="text"]:visible').first();
    await input.fill(`sessioninit${id}${Date.now() % 10000}`);
    await page.waitForTimeout(200);
    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
    await page.waitForTimeout(3000);
    if (page.url().includes('/password')) {
      await page.goBack();
      await page.waitForTimeout(2000);
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
  console.log(`${label} ${ok ? '✅' : '❌'} ${setupTime}s | XSRF: ${xsrfToken.substring(0, 20)}... | TL: ${tlToken.substring(0, 20)}...`);

  return { id, page, ctx, xsrfToken, tlToken, requestCount: 0, degradeCount: 0, ok };
}


// ==================== Worker：每个 context 的工作循环 ====================

async function worker(session, browser, getNextUsername) {
  const label = `[W${session.id}]`;
  let consecutiveErrors = 0;
  let retryUsername = null; // 需要重试的用户名

  while (!isShuttingDown) {
    // 获取用户名：优先重试，否则取新的
    const username = retryUsername || getNextUsername();
    retryUsername = null;
    if (!username) break;

    // 探针检测
    if (session.requestCount > 0 && session.requestCount % CONFIG.PROBE_INTERVAL === 0) {
      const probe = await checkUsernameAPI(session.page, PROBE_USERNAME, session.xsrfToken, session.tlToken);
      if (probe.status !== 'available') {
        log(`${label} 探针异常: ${probe.status} ${probe.reason || ''}`);
        console.log(`${label} ⚠️ 探针异常，刷新 session...`);
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser, session.id);
        if (!session.ok) {
          log(`${label} Session 刷新失败`);
          break;
        }
      }
    }

    // 发请求（先获取全局速率令牌）
    await rateLimiter.acquire();
    const result = await checkUsernameAPI(session.page, username, session.xsrfToken, session.tlToken);
    session.requestCount++;

    // 处理降级
    if (result.status === 'degraded') {
      session.degradeCount++;
      rateLimiter.onDegrade(); // 通知全局限速器减速
      log(`${label} 降级 #${session.degradeCount}: ${username}`);

      if (session.degradeCount <= 3) {
        // 前 3 次：短暂等待后重试同一个用户名
        const delay = 1000 + session.degradeCount * 500; // 1.5s, 2s, 2.5s
        log(`${label} 降级退避 ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        retryUsername = username;
        continue;
      }

      if (session.degradeCount <= CONFIG.MAX_CONSECUTIVE_DEGRADE) {
        // 4-8 次：跳过当前用户名，等一下再继续下一个
        log(`${label} 降级跳过 ${username}，等待 3s`);
        await new Promise(r => setTimeout(r, 3000));
        // 不重试这个用户名，让它被下次 getNextUsername 重新分配
        continue;
      }

      // 连续降级太多，刷新 session
      console.log(`${label} ⚠️ 连续降级 ${session.degradeCount} 次，刷新 session...`);
      try { await session.ctx.close(); } catch {}
      session = await setupSession(browser, session.id);
      session.degradeCount = 0;
      if (!session.ok) break;
      retryUsername = username; // 刷新后重试
      continue;
    }

    session.degradeCount = 0; // 重置降级计数
    rateLimiter.onSuccess(); // 通知全局限速器

    // 处理频率限制
    if (result.status === 'ratelimit') {
      log(`${label} 频率限制: ${username}`);
      console.log(`${label} ⏳ 频率限制，等待 ${CONFIG.RATE_LIMIT_DELAY/1000}s...`);
      await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_DELAY));
      retryUsername = username;
      continue;
    }

    // 处理错误
    if (result.status === 'error') {
      consecutiveErrors++;
      log(`${label} 错误 #${consecutiveErrors}: ${username} -> ${result.reason}`);

      if (consecutiveErrors >= CONFIG.SESSION_REFRESH_ERRORS) {
        console.log(`${label} ⚠️ 连续 ${consecutiveErrors} 错误，刷新 session...`);
        try { await session.ctx.close(); } catch {}
        session = await setupSession(browser, session.id);
        consecutiveErrors = 0;
        if (!session.ok) break;
        retryUsername = username;
        continue;
      }

      if (consecutiveErrors <= 2) {
        await new Promise(r => setTimeout(r, 1000));
        retryUsername = username;
        continue;
      }

      // 放弃这个用户名
      processed.add(username);
      appendToFile(FAILED_FILE, `${username}\t重试失败:${result.reason}`);
      failedCount++;
      totalChecked++;
      consecutiveErrors = 0;
      continue;
    }

    consecutiveErrors = 0;

    // 记录结果
    processed.add(username);
    totalChecked++;

    if (result.status === 'available') {
      appendToFile(AVAILABLE_FILE, username);
      availableCount++;
      console.log(`  ✅ ${username} — 可用!`);
    } else {
      appendToFile(FAILED_FILE, `${username}\t${result.status}${result.reason ? ':' + result.reason : ''}`);
      failedCount++;
    }

    // 定期保存
    if (totalChecked % CONFIG.SAVE_INTERVAL === 0) {
      saveProgress();
    }

    // 请求间隔由全局速率限制器控制，无需额外延迟
  }

  return session;
}


// ==================== 主流程 ====================

async function main() {
  inputFile = process.argv[2] || path.join(__dirname, '..', 'all_numbers.txt');

  if (!fs.existsSync(inputFile)) {
    console.log(`❌ 文件不存在: ${inputFile}`);
    process.exit(1);
  }

  allUsernames = fs.readFileSync(inputFile, 'utf-8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

  if (allUsernames.length === 0) {
    console.log('✅ 全部完成');
    process.exit(0);
  }

  // 读取已有计数
  if (fs.existsSync(AVAILABLE_FILE))
    availableCount = fs.readFileSync(AVAILABLE_FILE, 'utf-8').split('\n').filter(s => s.trim()).length;
  if (fs.existsSync(FAILED_FILE))
    failedCount = fs.readFileSync(FAILED_FILE, 'utf-8').split('\n').filter(s => s.trim()).length;

  console.log(`\n📧 Gmail 用户名检查器 (多 Context 并行版)`);
  console.log(`📊 待检查: ${allUsernames.length} | 并行: ${CONFIG.CONTEXT_COUNT} context | 全局限速: ${CONFIG.GLOBAL_MAX_RPS} req/s`);
  if (availableCount || failedCount) console.log(`📁 已有: ✅${availableCount} ❌${failedCount}`);
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  // 建立所有 session
  console.log(`🚀 建立 ${CONFIG.CONTEXT_COUNT} 个 session...\n`);
  const sessions = [];
  for (let i = 0; i < CONFIG.CONTEXT_COUNT; i++) {
    try {
      const s = await setupSession(browser, i);
      if (s.ok) {
        // 探针验证
        const probe = await checkUsernameAPI(s.page, PROBE_USERNAME, s.xsrfToken, s.tlToken);
        if (probe.status === 'available') {
          sessions.push(s);
          console.log(`[S${i}] ✅ 探针通过\n`);
        } else {
          console.log(`[S${i}] ❌ 探针失败: ${probe.status} ${probe.reason || ''}`);
          try { await s.ctx.close(); } catch {}
        }
      }
    } catch (e) {
      console.log(`[S${i}] ❌ 建立失败: ${e.message.substring(0, 50)}`);
    }
  }

  if (sessions.length === 0) {
    console.log('❌ 没有可用的 session');
    await browser.close();
    process.exit(1);
  }

  console.log(`\n✅ ${sessions.length}/${CONFIG.CONTEXT_COUNT} 个 session 就绪`);
  console.log(`🚀 开始批量检查...\n`);

  // 用户名分配器（线程安全的 round-robin）
  let usernameIndex = 0;
  function getNextUsername() {
    while (usernameIndex < allUsernames.length) {
      const u = allUsernames[usernameIndex++];
      if (!processed.has(u)) return u;
    }
    return null;
  }

  // 状态显示定时器
  const statusInterval = setInterval(() => {
    if (isShuttingDown) return;
    const { speed, remaining, etaStr, pct } = getStats();
    process.stdout.write(`\r📊 ${totalChecked}/${allUsernames.length} (${pct}%) | ${speed.toFixed(1)}/s [cap:${rateLimiter.getEffectiveRps()}] | ✅${availableCount} ❌${failedCount} | ETA: ${etaStr}   `);
  }, 2000);

  // 启动所有 worker 并行运行（错开启动，避免同时请求）
  const workerPromises = sessions.map((s, idx) => {
    return new Promise(resolve => {
      setTimeout(() => resolve(worker(s, browser, getNextUsername)), idx * CONFIG.WORKER_STAGGER_DELAY);
    });
  });
  await Promise.all(workerPromises);

  clearInterval(statusInterval);

  // 最终保存
  saveProgress();

  const { elapsed, speed } = getStats();
  console.log('\n\n' + '='.repeat(50));
  console.log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}  📊 总计: ${totalChecked}`);
  console.log(`⏱️ ${elapsed.toFixed(0)}s | ${speed.toFixed(1)} req/s | ${sessions.length} contexts`);
  console.log('='.repeat(50));

  await browser.close();
}

main().catch(err => {
  console.error('致命错误:', err);
  saveProgress();
  process.exit(1);
});
