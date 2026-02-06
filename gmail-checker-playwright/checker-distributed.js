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

      if (result.status !== 200) {
        return { status: 'error', reason: `HTTP ${result.status}`, raw: debug ? result.text.substring(0, 500) : undefined };
      }

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

      if (!inner) {
        return { status: 'error', reason: '响应解析失败', raw: debug ? result.text.substring(0, 500) : undefined };
      }

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
  }, { username, xsrfToken, tlToken, debug });
}

// ==================== Session 建立 ====================

async function setupSession(browser) {
  log('建立 session...');
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
      try {
        const u = new URL(req.url());
        tlToken = u.searchParams.get('TL') || tlToken;
      } catch {}
    }
  });

  // 辅助函数：点击下一步按钮（兼容中英文）
  async function clickNext() {
    const btn = page.locator('button:has-text("Next"), button:has-text("下一步")').first();
    await btn.click();
  }

  // 辅助函数：等待并记录当前页面
  async function logPage(step) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    log(`[${step}] URL: ${url.substring(0, 80)}... | Title: ${title.substring(0, 50)}`);
  }

  // Step 1: 打开注册页
  await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp&hl=en',
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await logPage('打开注册页');

  // Step 2: 填名字
  try {
    const nameInputs = page.locator('input[type="text"]:visible');
    const count = await nameInputs.count();
    log(`找到 ${count} 个文本输入框`);
    if (count >= 2) {
      await nameInputs.nth(0).fill('Test');
      await nameInputs.nth(1).fill('User');
    } else if (count >= 1) {
      await nameInputs.nth(0).fill('Test User');
    }
    await page.waitForTimeout(500);
    await clickNext();
    await page.waitForTimeout(4000);
    await logPage('填名字后');
  } catch (e) { log(`填名字失败: ${e.message}`); }

  // Step 3: 填生日和性别
  // 检查是否在生日页面
  const currentUrl = page.url();
  if (currentUrl.includes('birthday') || currentUrl.includes('birthdaygender')) {
    log('检测到生日页面，开始填写...');
    try {
      // 等待页面加载
      await page.waitForSelector('input', { timeout: 10000 });
      
      // 找到所有输入框和下拉框
      const inputs = page.locator('input:visible');
      const comboboxes = page.locator('[role="combobox"]:visible, select:visible');
      const inputCount = await inputs.count();
      const comboCount = await comboboxes.count();
      log(`生日页面: ${inputCount} 个输入框, ${comboCount} 个下拉框`);

      // 月份下拉框（通常是第一个 combobox）
      if (comboCount > 0) {
        await comboboxes.nth(0).click();
        await page.waitForTimeout(500);
        // 选择第一个选项（January）
        const options = page.locator('[role="option"]:visible, option:visible');
        if (await options.count() > 0) {
          await options.nth(1).click(); // 跳过 placeholder，选 January
          await page.waitForTimeout(300);
        }
      }

      // 日期输入框
      if (inputCount > 0) {
        // 找到 day 输入框（通常标签包含 Day）
        const dayInput = page.locator('input[aria-label*="Day" i], input[aria-label*="日" i]').first();
        if (await dayInput.count() > 0) {
          await dayInput.fill('15');
        } else {
          // fallback: 第一个数字输入框
          await inputs.nth(0).fill('15');
        }
        await page.waitForTimeout(200);
      }

      // 年份输入框
      const yearInput = page.locator('input[aria-label*="Year" i], input[aria-label*="年" i]').first();
      if (await yearInput.count() > 0) {
        await yearInput.fill('1990');
      } else if (inputCount > 1) {
        await inputs.nth(inputCount - 1).fill('1990');
      }
      await page.waitForTimeout(200);

      // 性别下拉框（通常是第二个 combobox）
      if (comboCount > 1) {
        await comboboxes.nth(1).click();
        await page.waitForTimeout(500);
        const genderOptions = page.locator('[role="option"]:visible');
        if (await genderOptions.count() > 1) {
          await genderOptions.nth(1).click(); // 选第一个非空选项
          await page.waitForTimeout(300);
        }
      }

      await page.waitForTimeout(500);
      await clickNext();
      await page.waitForTimeout(5000);
      await logPage('填生日后');
    } catch (e) { log(`填生日失败: ${e.message}`); }
  }

  // Step 4: 处理用户名选择页面
  // 可能直接到用户名页面，也可能需要选择 "Create your own"
  await page.waitForTimeout(2000);
  await logPage('用户名页面前');

  // 检查是否有 radio 按钮（选择用户名方式）
  try {
    const radios = page.locator('[role="radio"]');
    const radioCount = await radios.count();
    log(`找到 ${radioCount} 个 radio 按钮`);
    if (radioCount > 0) {
      // 选最后一个（通常是 "Create your own Gmail address"）
      await radios.nth(radioCount - 1).click();
      await page.waitForTimeout(1000);
      log('已选择自定义用户名选项');
    }
  } catch (e) { log(`选择 radio 失败: ${e.message}`); }

  // Step 5: 输入一个用户名触发 API 请求获取 tokens
  try {
    const usernameInput = page.locator('input[type="text"]:visible').first();
    if (await usernameInput.count() > 0) {
      await usernameInput.fill(`testinit${Date.now() % 100000}`);
      await page.waitForTimeout(500);
      await clickNext();
      await page.waitForTimeout(4000);
      await logPage('提交用户名后');

      // 如果跳到了密码页，说明用户名可用，需要返回
      if (page.url().includes('/password')) {
        log('跳到密码页，返回用户名页...');
        await page.goBack();
        await page.waitForTimeout(3000);
        // 重新选择自定义用户名
        try {
          const r = page.locator('[role="radio"]');
          if (await r.count() > 0) {
            await r.nth((await r.count()) - 1).click();
            await page.waitForTimeout(500);
          }
        } catch {}
      }
    } else {
      log('⚠️ 没有找到用户名输入框！');
    }
  } catch (e) { log(`触发 token 失败: ${e.message}`); }

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
  log(`最终页面: ${page.url()}`);

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
    headless: false,  // 使用 headed 模式 + xvfb 绕过检测
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  let session = await setupSession(browser);
  if (!session.ok) {
    log('❌ Session 建立失败');
    await browser.close();
    process.exit(1);
  }

  // 探针验证（带调试 + 重试）
  let probeOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`探针验证 (尝试 ${attempt}/3)...`);
    
    // 先截图看看当前页面状态
    try {
      const screenshotPath = path.join(outputDir, `debug-page-attempt${attempt}.png`);
      await session.page.screenshot({ path: screenshotPath });
      log(`截图已保存: ${screenshotPath}`);
    } catch (e) { log(`截图失败: ${e.message}`); }
    
    // 打印当前 URL
    log(`当前页面 URL: ${session.page.url()}`);
    
    // 打印页面标题
    try {
      const title = await session.page.title();
      log(`页面标题: ${title}`);
    } catch {}
    
    const probe = await checkUsernameAPI(session.page, PROBE_USERNAME, session.xsrfToken, session.tlToken, true);
    log(`探针结果: ${JSON.stringify(probe)}`);
    
    if (probe.status === 'available') {
      probeOk = true;
      break;
    }
    
    // 探针失败，尝试重建 session
    if (attempt < 3) {
      log(`探针失败，等待 5s 后重建 session...`);
      await new Promise(r => setTimeout(r, 5000));
      try { await session.ctx.close(); } catch {}
      session = await setupSession(browser);
      if (!session.ok) {
        log(`Session 重建失败`);
        continue;
      }
    }
  }
  
  if (!probeOk) {
    log('❌ 探针 3 次尝试全部失败，退出');
    // 上传调试截图
    saveProgress();
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
