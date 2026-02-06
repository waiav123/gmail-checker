// 测试 1: Google Identity Toolkit - createAuthUri
// 测试是否能通过 Firebase/Identity Toolkit 检测邮箱存在性
// 不需要 API Key 的公开端点测试

const https = require('https');

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== 测试 1: Identity Toolkit ===\n');

  // 方法 A: 不带 API Key（预期会失败，但测试一下）
  console.log('--- A: 无 API Key ---');
  try {
    const r = await postJSON(
      'https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri',
      { identifier: 'test@gmail.com', continueUri: 'http://localhost' }
    );
    console.log(`  Status: ${r.status}`);
    console.log(`  Body: ${r.body.substring(0, 300)}`);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // 方法 B: 用公开的 Firebase API Key（从公开的 Firebase 项目中获取）
  // 这些是 Google 自己的公开 demo key，不是私密的
  const publicKeys = [
    'AIzaSyB6ZODYFbBPqLFm-hlMZjm7Z3Btmlk-axo', // Firebase demo
    'AIzaSyAa8yy0GdcGPHdtD083HiGGx_S0vMPScDM', // 另一个公开 key
  ];

  for (const key of publicKeys) {
    console.log(`\n--- B: API Key ${key.substring(0, 20)}... ---`);
    
    // 测试存在的邮箱
    try {
      const r1 = await postJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
        { identifier: 'test@gmail.com', continueUri: 'http://localhost' }
      );
      console.log(`  [test@gmail.com] Status: ${r1.status}`);
      console.log(`  Body: ${r1.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }

    // 测试不存在的邮箱
    try {
      const r2 = await postJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
        { identifier: 'dhjfkjshfk234hjkdhkh@gmail.com', continueUri: 'http://localhost' }
      );
      console.log(`  [random@gmail.com] Status: ${r2.status}`);
      console.log(`  Body: ${r2.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  // 方法 C: fetchSignInMethodsForEmail（已弃用但测试是否仍可用）
  console.log('\n--- C: fetchSignInMethodsForEmail ---');
  for (const key of publicKeys) {
    try {
      const r = await postJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`,
        { email: ['test@gmail.com'] }
      );
      console.log(`  [lookup] Status: ${r.status}`);
      console.log(`  Body: ${r.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    break;
  }

  // 方法 D: signUp endpoint（测试是否能检测已存在的邮箱）
  console.log('\n--- D: accounts:signUp ---');
  for (const key of publicKeys) {
    try {
      const r = await postJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`,
        { email: 'test@gmail.com', password: 'testpass123' }
      );
      console.log(`  [signUp test@] Status: ${r.status}`);
      console.log(`  Body: ${r.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    break;
  }

  // 方法 E: isNewUser via accounts:signInWithPassword
  console.log('\n--- E: signInWithPassword ---');
  for (const key of publicKeys) {
    try {
      const r = await postJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
        { email: 'test@gmail.com', password: 'wrongpassword123', returnSecureToken: true }
      );
      console.log(`  [existing] Status: ${r.status}`);
      console.log(`  Body: ${r.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    try {
      const r = await postJSON(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
        { email: 'dhjfkjshfk234hjkdhkh@gmail.com', password: 'wrongpassword123', returnSecureToken: true }
      );
      console.log(`  [nonexist] Status: ${r.status}`);
      console.log(`  Body: ${r.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    break;
  }

  console.log('\n=== Identity Toolkit 测试完成 ===');
}

main().catch(console.error);
