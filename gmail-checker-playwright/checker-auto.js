// Gmail 用户名检查器 - 智能识别版 v3
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const processed = new Set();
let page, browser, inputFile, allUsernames;
let availableCount = 0, failedCount = 0;

const PROBE_USERNAME = 'dhjfkjshfk234hjkdhkh';
const OUTPUT_DIR = __dirname;
const AVAILABLE_FILE = path.join(OUTPUT_DIR, 'available.txt');
const FAILED_FILE = path.join(OUTPUT_DIR, 'failed.txt');
const LOG_FILE = path.join(OUTPUT_DIR, 'checker.log');
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');

// ==================== 工具函数 ====================

function appendToFile(filePath, line) {
  try {
    fs.appendFileSync(filePath, line + '\n');
  } catch (e) {
    console.log(`   ⚠️ 写入文件失败: ${e.message}`);
    log(`写入失败 ${filePath}: ${e.message}`);
  }
}

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

function removeProcessedFromSource() {
  if (processed.size === 0) return;
  try {
    const remaining = allUsernames.filter(u => !processed.has(u));
    fs.writeFileSync(inputFile, remaining.join('\n'));
  } catch (e) {
    console.log(`   ⚠️ 保存进度失败: ${e.message}`);
    log(`保存进度失败: ${e.message}`);
  }
}

function gracefulExit() {
  console.log('\n\n⚠️ 正在保存进度...');
  removeProcessedFromSource();
  console.log(`📝 已处理 ${processed.size} 个，剩余 ${allUsernames.length - processed.size} 个`);
  console.log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}`);
  log(`退出: 已处理${processed.size} 可用${availableCount} 失败${failedCount}`);
  try { browser.close(); } catch {}
  process.exit(0);
}

// 注册信号处理，Ctrl+C 时保存进度
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

// 未知页面截图，方便排查
async function screenshotUnknown(label) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);
    const ts = Date.now();
    const file = path.join(SCREENSHOT_DIR, `${label}-${ts}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`   📸 截图已保存: ${path.basename(file)}`);
    log(`截图: ${label} -> ${file}`);
  } catch (e) {
    log(`截图失败: ${e.message}`);
  }
}

// 检测浏览器是否还活着
async function isBrowserAlive() {
  try {
    await page.evaluate(() => document.title);
    return true;
  } catch {
    return false;
  }
}

// 重启浏览器（崩溃恢复）
async function restartBrowser() {
  console.log('\n🔄 重启浏览器...');
  log('浏览器重启');
  try { await browser.close(); } catch {}

  browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(15000);
}

// ==================== 页面识别 ====================

async function detectPage() {
  const url = page.url();

  // 等待页面内容稳定（SPA 可能还在加载）
  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    text = await page.locator('body').innerText().catch(() => '');
    if (text.length > 20) break; // 内容足够了
    await page.waitForTimeout(800);
  }

  // 按 URL 判断
  if (url.includes('/signup/name') || url.includes('steps/signup/name')) return 'name';
  if (url.includes('birthdaygender') || url.includes('birthday')) return 'birthday';
  if (url.includes('username')) {
    if (text.includes('创建一个邮箱') || text.includes('创建您自己的') ||
        text.includes('Create a Gmail') || text.includes('Create your own')) {
      return 'username-choose';
    }
    return 'username-input';
  }
  if (url.includes('password')) return 'password';

  // 按内容判断
  if (text.includes('请输入您的姓名') || text.includes('Enter your name')) return 'name';
  if (text.includes('输入您的生日') || text.includes('Enter your birthday')) return 'birthday';

  // 恢复邮箱页面
  if (text.includes('添加辅助邮箱') || text.includes('recovery email') ||
      text.includes('恢复电子邮件') || text.includes('Add recovery email') ||
      url.includes('recoveryemail')) {
    return 'recovery-email';
  }

  // 手机验证
  if (text.includes('添加电话号码') || text.includes('验证您的手机') ||
      text.includes('Add phone number') || text.includes('Verify your phone') ||
      text.includes('输入电话号码') || text.includes('Enter a phone number') ||
      url.includes('phoneverification') || url.includes('phone')) {
    return 'phone-verify';
  }

  // 验证码 / 安全验证（用更精确的关键词，避免误判）
  if (text.includes('验证您不是机器人') || text.includes('robot') || text.includes('recaptcha') ||
      (text.includes('验证您的身份') && !text.includes('电话') && !text.includes('phone'))) {
    return 'captcha';
  }

  // 被封锁
  if (text.includes('此浏览器或应用可能不安全') || text.includes('browser or app may not be secure')) {
    return 'blocked';
  }

  // 频率限制
  if (text.includes('请求过多') || text.includes('Too many') || text.includes('稍后再试') ||
      text.includes('try again later') || text.includes('unusual traffic')) {
    return 'rate-limited';
  }

  // 服务条款
  if (text.includes('服务条款') || text.includes('Terms of Service') ||
      text.includes('隐私权政策') || text.includes('Privacy Policy')) {
    if (url.includes('terms') || url.includes('consent')) return 'terms';
  }

  // Cookie 同意弹窗
  if (text.includes('使用 Cookie') || text.includes('use cookies') ||
      text.includes('接受所有') || text.includes('Accept all')) {
    return 'cookie-consent';
  }

  // 账号恢复 / 安全挑战
  if (url.includes('recovery') || url.includes('challenge')) return 'challenge';

  return 'unknown';
}

// ==================== 页面操作 ====================

async function handleNamePage() {
  console.log('   📝 填写姓名...');
  const inputs = page.locator('input[type="text"]:visible, input[name="firstName"], input[name="lastName"]');
  const count = await inputs.count();
  if (count >= 2) {
    await inputs.nth(0).fill('Test');
    await page.waitForTimeout(200);
    await inputs.nth(1).fill('User');
  } else if (count === 1) {
    await inputs.nth(0).fill('Test');
  } else {
    // fallback: 尝试所有 input
    await page.locator('input').first().fill('Test');
  }
  await page.waitForTimeout(300);
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(2500);
}

async function handleBirthdayPage() {
  console.log('   📝 填写生日性别...');
  await page.waitForSelector('input', { timeout: 10000 });

  await page.locator('input').first().fill('1990');
  await page.waitForTimeout(200);

  await page.locator('[role="combobox"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[role="listbox"]:visible [role="option"]').first().click();
  await page.waitForTimeout(400);

  await page.locator('input').nth(1).fill('15');
  await page.waitForTimeout(200);

  await page.locator('[role="combobox"]').nth(1).click();
  await page.waitForTimeout(400);
  await page.locator('[role="listbox"]:visible [role="option"]').nth(1).click();
  await page.waitForTimeout(400);

  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(2500);
}

async function handleUsernameChoosePage() {
  console.log('   📝 选择自定义用户名...');
  const radios = page.locator('[role="radio"], input[type="radio"]');
  const count = await radios.count();
  if (count > 0) {
    await radios.nth(count - 1).click();
    await page.waitForTimeout(800);
  }
}

async function handleManualIntervention(reason) {
  console.log(`\n⚠️ ${reason}`);
  console.log('   请在浏览器中手动处理，完成后按 Enter 继续');
  log(`需要手动处理: ${reason}`);

  // 每 30 秒提醒一次，防止用户忘记
  const reminder = setInterval(() => {
    console.log('   ⏰ 提醒: 手动处理完成后请按 Enter 继续...');
  }, 30000);

  await new Promise(r => process.stdin.once('data', () => r()));
  clearInterval(reminder);
}

// 尝试跳过手机验证（有些流程有"跳过"按钮）
async function trySkipPhoneVerify() {
  console.log('   📱 检测到手机验证，尝试跳过...');
  const skipBtn = page.locator('button:has-text("跳过"), button:has-text("Skip"), a:has-text("跳过"), a:has-text("Skip")').first();
  if (await skipBtn.count() > 0) {
    await skipBtn.click();
    await page.waitForTimeout(2000);
    console.log('   ✅ 已跳过手机验证');
    return true;
  }
  return false;
}

// 处理恢复邮箱页面（跳过或填写）
async function handleRecoveryEmail() {
  console.log('   📧 检测到恢复邮箱页面，尝试跳过...');
  const skipBtn = page.locator('button:has-text("跳过"), button:has-text("Skip"), a:has-text("跳过"), a:has-text("Skip")').first();
  if (await skipBtn.count() > 0) {
    await skipBtn.click();
    await page.waitForTimeout(2000);
    return;
  }
  // 没有跳过按钮，点下一步（留空）
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click().catch(() => {});
  await page.waitForTimeout(2000);
}

// 处理 Cookie 同意弹窗
async function handleCookieConsent() {
  console.log('   🍪 处理 Cookie 同意弹窗...');
  const acceptBtn = page.locator('button:has-text("接受所有"), button:has-text("Accept all"), button:has-text("全部接受"), button:has-text("I agree")').first();
  if (await acceptBtn.count() > 0) {
    await acceptBtn.click();
    await page.waitForTimeout(1000);
  }
}

// 未知页面尝试点击"下一步"或"跳过"碰运气
async function tryAdvanceUnknownPage() {
  const skipBtn = page.locator('button:has-text("跳过"), button:has-text("Skip")').first();
  if (await skipBtn.count() > 0) {
    console.log('   🔀 未知页面，尝试点击"跳过"...');
    await skipBtn.click();
    await page.waitForTimeout(2000);
    return;
  }
  const nextBtn = page.locator('button:has-text("下一步"), button:has-text("Next")').first();
  if (await nextBtn.count() > 0) {
    console.log('   🔀 未知页面，尝试点击"下一步"...');
    await nextBtn.click();
    await page.waitForTimeout(2000);
    return;
  }
}

// ==================== 导航到用户名页面 ====================

async function navigateToUsernamePage() {
  console.log('🔄 导航到用户名页面...');

  // 先检查浏览器是否还活着
  if (!await isBrowserAlive()) {
    await restartBrowser();
  }

  try {
    await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log(`   ⚠️ 页面加载失败: ${e.message.substring(0, 50)}`);
    log(`导航失败: ${e.message}`);
    // 网络问题，等一会重试
    await page.waitForTimeout(5000).catch(() => {});
    try {
      await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
        { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e2) {
      console.log('   ❌ 二次加载仍失败');
      return false;
    }
  }

  await page.waitForTimeout(2000);

  for (let step = 0; step < 10; step++) {
    const pageType = await detectPage();
    console.log(`   当前页面: ${pageType}`);

    switch (pageType) {
      case 'name':
        await handleNamePage();
        break;
      case 'birthday':
        await handleBirthdayPage();
        break;
      case 'username-choose':
        await handleUsernameChoosePage();
        const afterChoose = await detectPage();
        if (afterChoose === 'username-input' || afterChoose === 'username-choose') {
          console.log('✅ 已到达用户名页面\n');
          return true;
        }
        break;
      case 'username-input':
        console.log('✅ 已到达用户名页面\n');
        return true;
      case 'phone-verify':
        if (!await trySkipPhoneVerify()) {
          await handleManualIntervention('手机验证无法自动跳过，需要手动处理');
        }
        break;
      case 'captcha':
        await handleManualIntervention('检测到验证码/安全验证，需要手动处理');
        break;
      case 'blocked':
        await handleManualIntervention('浏览器被标记为不安全，需要手动处理');
        break;
      case 'rate-limited':
        console.log('   ⏳ 被频率限制，等待 60 秒...');
        log('频率限制，等待60s');
        await page.waitForTimeout(60000);
        // 重新加载
        await page.goto('https://accounts.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp',
          { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2000);
        break;
      case 'terms':
        console.log('   📝 服务条款页面，尝试同意...');
        await page.locator('button:has-text("同意"), button:has-text("I agree"), button:has-text("Accept")').first().click().catch(() => {});
        await page.waitForTimeout(2000);
        break;
      case 'cookie-consent':
        await handleCookieConsent();
        break;
      case 'recovery-email':
        await handleRecoveryEmail();
        break;
      case 'challenge':
        await handleManualIntervention('检测到安全挑战，需要手动处理');
        break;
      case 'password':
        await page.goBack();
        await page.waitForTimeout(1500);
        break;
      default:
        await screenshotUnknown('navigate-unknown');
        await tryAdvanceUnknownPage();
        break;
    }
  }

  console.log('❌ 无法到达用户名页面');
  await screenshotUnknown('navigate-failed');
  return false;
}

// ==================== 检查用户名 ====================

async function checkUsername(username) {
  // 浏览器存活检查
  if (!await isBrowserAlive()) {
    await restartBrowser();
    if (!await navigateToUsernamePage()) {
      return { status: 'error', reason: '浏览器崩溃且无法恢复' };
    }
  }

  let pageType = await detectPage();

  // 如果不在用户名页面，尝试恢复
  if (pageType !== 'username-input' && pageType !== 'username-choose') {
    if (pageType === 'password') {
      await page.goBack();
      await page.waitForTimeout(1500);
      pageType = await detectPage();
    } else if (pageType === 'captcha' || pageType === 'blocked') {
      await handleManualIntervention(`检测到 ${pageType}，需要手动处理`);
      pageType = await detectPage();
    } else if (pageType === 'phone-verify') {
      if (!await trySkipPhoneVerify()) {
        await handleManualIntervention('手机验证无法自动跳过，需要手动处理');
      }
      pageType = await detectPage();
    } else if (pageType === 'recovery-email') {
      await handleRecoveryEmail();
      pageType = await detectPage();
    } else if (pageType === 'cookie-consent') {
      await handleCookieConsent();
      pageType = await detectPage();
    } else if (pageType === 'rate-limited') {
      console.log('\n   ⏳ 频率限制，等待 60 秒...');
      log('频率限制');
      await page.waitForTimeout(60000);
      pageType = await detectPage(); // 重新检测
    }

    if (pageType !== 'username-input' && pageType !== 'username-choose') {
      console.log('');
      if (!await navigateToUsernamePage()) {
        return { status: 'error', reason: '无法恢复页面' };
      }
      pageType = await detectPage();
    }
  }

  if (pageType === 'username-choose') {
    await handleUsernameChoosePage();
  }

  try {
    const input = page.locator('input[type="text"]:visible').first();
    const inputCount = await input.count();

    if (inputCount === 0) {
      await screenshotUnknown('no-input');
      return { status: 'error', reason: '找不到输入框' };
    }

    await input.fill('');
    await page.waitForTimeout(100);
    await input.fill(username);
    await page.waitForTimeout(200);

    const beforeUrl = page.url();

    await page.locator('button:has-text("下一步"), button:has-text("Next")').click();

    // 智能等待
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(300);

      const currentUrl = page.url();
      if (currentUrl !== beforeUrl) break;

      const mainText = await page.locator('main').innerText().catch(() => '');
      if (mainText.includes('已有人使用') || mainText.includes('is taken') ||
          mainText.includes('不允许使用') || mainText.includes('not allowed') ||
          mainText.includes('长度必须') || mainText.includes('只能包含') ||
          mainText.includes('请求过多') || mainText.includes('Too many')) {
        break;
      }
    }

    const url = page.url();

    if (url.includes('/password')) {
      await page.goBack();
      await page.waitForTimeout(1500);
      // 验证是否回到了用户名页面
      const backPage = await detectPage();
      if (backPage !== 'username-input' && backPage !== 'username-choose') {
        log(`goBack后未回到用户名页面: ${backPage}`);
        await navigateToUsernamePage();
      }
      return { status: 'available', reason: '可用' };
    }

    // 检查是否跳到了手机验证（有时可用的用户名也会触发）
    if (url.includes('phone') || url.includes('phoneverification')) {
      log(`${username}: 触发手机验证，视为可用`);
      await page.goBack().catch(() => {});
      await page.waitForTimeout(1500);
      return { status: 'available', reason: '可用(触发手机验证)' };
    }

    const text = await page.locator('main').innerText().catch(() => '');

    if (text.includes('已有人使用') || text.includes('is taken')) {
      return { status: 'taken', reason: '已被占用' };
    }
    if (text.includes('不允许使用') || text.includes('not allowed')) {
      return { status: 'invalid', reason: '不允许使用' };
    }
    if (text.includes('长度必须') || text.includes('between 6')) {
      return { status: 'invalid', reason: '长度错误' };
    }
    if (text.includes('只能包含') || text.includes('can only contain')) {
      return { status: 'invalid', reason: '含非法字符' };
    }
    if (text.includes('请求过多') || text.includes('Too many') || text.includes('稍后再试')) {
      return { status: 'error', reason: '频率限制' };
    }

    // 未知结果，截图留证（清理文件名中的非法字符）
    const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    await screenshotUnknown(`check-unknown-${safeUsername}`);
    return { status: 'unknown', reason: '未知状态' };

  } catch (err) {
    const msg = err.message.split('\n')[0].substring(0, 60);
    log(`checkUsername异常: ${username} -> ${msg}`);

    // 网络相关错误
    if (msg.includes('net::') || msg.includes('timeout') || msg.includes('Navigation') ||
        msg.includes('Target closed') || msg.includes('Session closed')) {
      return { status: 'error', reason: `网络/浏览器异常: ${msg.substring(0, 30)}` };
    }

    return { status: 'error', reason: msg.substring(0, 40) };
  }
}

// ==================== 探针校验 ====================

async function probeCheck() {
  process.stdout.write(`   🔬 探针校验 [${PROBE_USERNAME}]... `);
  const result = await checkUsername(PROBE_USERNAME);

  if (result.status === 'available') {
    console.log('✅ 环境正常');
    return true;
  }

  console.log(`❌ 异常! 结果=${result.reason}`);
  log(`探针异常: ${result.reason}`);
  console.log('   ⚠️ 检测环境可能已失效，重新初始化...');

  if (await navigateToUsernamePage()) {
    process.stdout.write(`   🔬 二次校验... `);
    const retry = await checkUsername(PROBE_USERNAME);
    if (retry.status === 'available') {
      console.log('✅ 恢复正常');
      return true;
    }
    console.log(`❌ 仍然异常: ${retry.reason}`);
  }

  await handleManualIntervention('环境无法自动恢复，请手动检查浏览器');
  return true;
}

// ==================== 主流程 ====================

async function main() {
  inputFile = process.argv[2] || path.join(__dirname, '..', 'all_numbers.txt');

  if (!fs.existsSync(inputFile)) {
    console.log(`❌ 文件不存在: ${inputFile}`);
    process.exit(1);
  }

  console.log(`📂 读取: ${inputFile}`);
  allUsernames = fs.readFileSync(inputFile, 'utf-8')
    .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

  if (allUsernames.length === 0) {
    console.log('✅ 全部完成');
    process.exit(0);
  }

  if (fs.existsSync(AVAILABLE_FILE)) {
    availableCount = fs.readFileSync(AVAILABLE_FILE, 'utf-8').split('\n').filter(s => s.trim()).length;
  }
  if (fs.existsSync(FAILED_FILE)) {
    failedCount = fs.readFileSync(FAILED_FILE, 'utf-8').split('\n').filter(s => s.trim()).length;
  }

  console.log(`\n📧 Gmail 用户名检查器 (智能版 v3)`);
  console.log(`📊 待检查: ${allUsernames.length}`);
  if (availableCount || failedCount) console.log(`📁 已有: ✅${availableCount} ❌${failedCount}`);
  console.log('');

  browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  if (!await navigateToUsernamePage()) {
    await browser.close();
    process.exit(1);
  }

  await probeCheck();

  const startTime = Date.now();
  let consecutiveErrors = 0;
  let checkedThisRun = 0;
  let lastSessionRefresh = Date.now();

  for (let i = 0; i < allUsernames.length; i++) {
    const username = allUsernames[i];
    checkedThisRun++;

    const elapsed = (Date.now() - startTime) / 1000 || 1; // 避免除以零
    const speed = checkedThisRun / elapsed;
    const remaining = (allUsernames.length - i - 1) / speed;
    const eta = remaining > 60 ? `${(remaining / 60).toFixed(0)}m` : `${remaining.toFixed(0)}s`;
    const pct = ((i + 1) / allUsernames.length * 100).toFixed(1);

    process.stdout.write(`[${i + 1}/${allUsernames.length} ${pct}% ETA:${eta}] ${username}... `);

    const result = await checkUsername(username);

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

      // error 的不跳过，回退 i 重试（最多重试 2 次）
      if (consecutiveErrors <= 2) {
        console.log(`   ↩️ 将重试 ${username}`);
        i--;
        checkedThisRun--;
        await page.waitForTimeout(2000);
        continue;
      }
      // 超过 2 次，当作失败记录
      processed.add(username);
      appendToFile(FAILED_FILE, `${username}\t重试失败:${result.reason}`);
      failedCount++;
      console.log(`   ❌ 重试失败，跳过`);
    }

    // 每 10 个保存进度 + 探针校验
    if ((i + 1) % 10 === 0) {
      removeProcessedFromSource();

      if (!await probeCheck()) {
        console.log('⚠️ 探针失败');
      }
    }

    // 连续错误过多，重新初始化
    if (consecutiveErrors >= 3) {
      console.log('\n⚠️ 连续错误，重新初始化...');
      log('连续错误，重新初始化');
      await restartBrowser();
      await navigateToUsernamePage();
      consecutiveErrors = 0;
    }

    // 每 50 个休息一下
    if ((i + 1) % 50 === 0 && i < allUsernames.length - 1) {
      console.log(`\n⏸️ ${pct}% | ✅${availableCount} ❌${failedCount} | 休息5s\n`);
      await page.waitForTimeout(5000);
    }

    // 每 30 分钟刷新 session（重新走注册流程）
    if (Date.now() - lastSessionRefresh > 30 * 60 * 1000) {
      console.log('\n🔄 定期刷新 session...');
      log('定期刷新session');
      await navigateToUsernamePage();
      lastSessionRefresh = Date.now();
    }

    await page.waitForTimeout(800);
  }

  removeProcessedFromSource();

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(40));
  console.log(`✅ 可用: ${availableCount}  ❌ 失败: ${failedCount}  ⏱️ ${totalElapsed}s`);
  log(`完成: 可用${availableCount} 失败${failedCount} 耗时${totalElapsed}s`);

  await browser.close();
}

main().catch(err => {
  console.error('致命错误:', err);
  log(`致命错误: ${err.message}`);
  removeProcessedFromSource();
  try { if (browser) browser.close(); } catch {}
  setTimeout(() => process.exit(1), 500); // 给 browser.close() 一点时间
});
