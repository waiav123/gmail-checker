// Identity Toolkit 测试 - 使用自己的 Firebase API Key
// 
// 获取 Key 步骤（5 分钟）：
// 1. 打开 https://console.firebase.google.com/
// 2. 创建新项目（随便起名，不需要 Google Analytics）
// 3. 项目设置 → 常规 → Web API Key（就是你需要的 key）
// 4. 确保 Identity Toolkit API 已启用：
//    https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com
//
// 用法: node test-idt-with-key.js YOUR_API_KEY

const { chromium } = require('playwright');

const API_KEY = process.argv[2];
if (!API_KEY) {
  console.log('用法: node test-idt-with-key.js YOUR_FIREBASE_API_KEY');
  console.log('\n获取 Key：');
  console.log('1. https://console.firebase.google.com/ → 创建项目');
  console.log('2. 项目设置 → Web API Key');
  console.log('3. 启用 Identity Toolkit API:');
  console.log('   https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com');
  process.exit(1);
}

async function checkEmail(page, email) {
  return await page.evaluate(async ({ email, key }) => {
    const start = Date.now();
    try {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: email, continueUri: 'http://localhost' }),
        }
      );
      const ms = Date.now() - start;
      const data = await resp.json();
      return { status: resp.status, registered: data.registered, kind: data.kind, ms, error: data.error?.message };
    } catch (e) {
      return { status: 'error', error: e.message, ms: Date.now() - start };
    }
  }, { email, key: API_KEY });
}

async function main() {
  console.log(`=== Identity Toolkit 测试 (Key: ${API_KEY.substring(0, 20)}...) ===\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');

  // 测试 1: 基本功能验证
  console.log('--- 1. 基本功能验证 ---');
  const testCases = [
    { email: '000001@gmail.com', expect: '存在' },
    { email: '999999@gmail.com', expect: '存在' },
    { email: 'dhjfkjshfk234hjkdhkh@gmail.com', expect: '不存在' },
    { email: 'qkbzh3240@gmail.com', expect: '不存在(随机)' },
    { email: 'test@gmail.com', expect: '存在' },
  ];

  let allCorrect = true;
  for (const { email, expect } of testCases) {
    const r = await checkEmail(page, email);
    const icon = r.status === 200 ? (r.registered ? '✅存在' : '❌不存在') : `⚠️${r.error?.substring(0, 40)}`;
    console.log(`  ${email.padEnd(40)} ${icon} (${r.ms}ms) [expect: ${expect}]`);
    if (r.status !== 200) allCorrect = false;
  }

  if (!allCorrect) {
    console.log('\n⚠️ API 调用失败，请检查 Key 是否正确且 Identity Toolkit API 已启用');
    await browser.close();
    return;
  }

  // 测试 2: 速率测试
  console.log('\n--- 2. 速率测试 ---');
  const rateTests = [10, 20, 50];
  for (const count of rateTests) {
    const start = Date.now();
    let success = 0, fail = 0;
    const promises = [];
    for (let i = 0; i < count; i++) {
      const email = `ratetest${i}${Date.now() % 10000}@gmail.com`;
      promises.push(checkEmail(page, email).then(r => {
        if (r.status === 200) success++; else fail++;
      }));
    }
    await Promise.all(promises);
    const elapsed = (Date.now() - start) / 1000;
    console.log(`  ${count} 并发: ${elapsed.toFixed(1)}s | ${(count/elapsed).toFixed(1)} req/s | ✅${success} ❌${fail}`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // 测试 3: 串行速率（无延迟）
  console.log('\n--- 3. 串行速率测试 ---');
  const serialCount = 30;
  const serialStart = Date.now();
  let serialOk = 0, serialFail = 0;
  for (let i = 0; i < serialCount; i++) {
    const r = await checkEmail(page, `serial${i}${Date.now() % 10000}@gmail.com`);
    if (r.status === 200) serialOk++; else { serialFail++; console.log(`    #${i} 失败: ${r.error}`); }
  }
  const serialElapsed = (Date.now() - serialStart) / 1000;
  console.log(`  ${serialCount} 串行: ${serialElapsed.toFixed(1)}s | ${(serialCount/serialElapsed).toFixed(1)} req/s | ✅${serialOk} ❌${serialFail}`);

  // 测试 4: 高并发测试
  console.log('\n--- 4. 高并发测试 (100 并发) ---');
  const highStart = Date.now();
  let highOk = 0, highFail = 0, highErrors = {};
  const highPromises = [];
  for (let i = 0; i < 100; i++) {
    highPromises.push(checkEmail(page, `high${i}${Date.now() % 10000}@gmail.com`).then(r => {
      if (r.status === 200) highOk++;
      else { highFail++; highErrors[r.error || r.status] = (highErrors[r.error || r.status] || 0) + 1; }
    }));
  }
  await Promise.all(highPromises);
  const highElapsed = (Date.now() - highStart) / 1000;
  console.log(`  100 并发: ${highElapsed.toFixed(1)}s | ${(100/highElapsed).toFixed(1)} req/s | ✅${highOk} ❌${highFail}`);
  if (Object.keys(highErrors).length > 0) {
    console.log(`  错误分布:`, highErrors);
  }

  await browser.close();
  console.log('\n=== 测试完成 ===');
  console.log(`\n如果测试通过，可以用这个 Key 构建纯 HTTP 版本的 checker，预期速度 10-50+ req/s`);
}

main().catch(console.error);
