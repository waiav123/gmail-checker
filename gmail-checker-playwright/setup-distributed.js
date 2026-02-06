// 分布式检查器快速设置脚本
// 用法: node setup-distributed.js <用户名文件> [批次数量]
// 例如: node setup-distributed.js ../smart_usernames.txt 10

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const inputFile = process.argv[2];
const batchCount = parseInt(process.argv[3]) || 5;

console.log('🚀 Gmail 分布式检查器设置\n');

if (!inputFile || !fs.existsSync(inputFile)) {
  console.log('用法: node setup-distributed.js <用户名文件> [批次数量]');
  console.log('例如: node setup-distributed.js ../smart_usernames.txt 10');
  process.exit(1);
}

// 1. 分割用户名
console.log('📦 Step 1: 分割用户名文件...');
const batchesDir = path.join(__dirname, 'batches');
if (!fs.existsSync(batchesDir)) {
  fs.mkdirSync(batchesDir, { recursive: true });
}

const usernames = fs.readFileSync(inputFile, 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));

const batchSize = Math.ceil(usernames.length / batchCount);
console.log(`   总用户名: ${usernames.length}`);
console.log(`   批次数量: ${batchCount}`);
console.log(`   每批大小: ~${batchSize}`);

for (let i = 0; i < batchCount; i++) {
  const start = i * batchSize;
  const end = Math.min(start + batchSize, usernames.length);
  const batch = usernames.slice(start, end);
  const outputFile = path.join(batchesDir, `batch-${i}.txt`);
  fs.writeFileSync(outputFile, batch.join('\n'));
}
console.log(`   ✅ 已创建 ${batchCount} 个批次文件\n`);

// 2. 更新 workflow 文件
console.log('📝 Step 2: 更新 GitHub Actions workflow...');
const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'gmail-checker.yml');
if (fs.existsSync(workflowPath)) {
  let workflow = fs.readFileSync(workflowPath, 'utf-8');
  
  // 更新 matrix batch 数组
  const matrixArray = Array.from({ length: batchCount }, (_, i) => i);
  workflow = workflow.replace(
    /batch: \[[\d, ]+\]/,
    `batch: [${matrixArray.join(', ')}]`
  );
  
  fs.writeFileSync(workflowPath, workflow);
  console.log(`   ✅ 已更新 matrix.batch 为 [0..${batchCount - 1}]\n`);
} else {
  console.log('   ⚠️ workflow 文件不存在，请手动创建\n');
}

// 3. 显示下一步
console.log('📋 下一步操作:\n');
console.log('   1. 提交更改到 GitHub:');
console.log('      git add .');
console.log('      git commit -m "Setup distributed checker"');
console.log('      git push\n');
console.log('   2. 在 GitHub 仓库页面:');
console.log('      Actions -> Gmail Username Checker -> Run workflow\n');
console.log('   3. 等待完成后下载 merged-results artifact\n');

// 4. 预估时间
const estimatedSpeed = 3 * batchCount; // 每个 job ~3 req/s
const estimatedTime = usernames.length / estimatedSpeed / 3600;
console.log('📊 预估性能:');
console.log(`   并行速度: ~${estimatedSpeed} req/s`);
console.log(`   预计时间: ~${estimatedTime.toFixed(1)} 小时`);
console.log(`   每小时处理: ~${(estimatedSpeed * 3600).toLocaleString()} 个\n`);

// 5. 本地测试命令
console.log('🧪 本地测试 (可选):');
console.log(`   node checker-distributed.js batches/batch-0.txt ./test-results\n`);
