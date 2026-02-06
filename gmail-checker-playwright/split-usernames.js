// 用户名分割脚本 - 将大文件分割成多个批次
// 用法: node split-usernames.js <输入文件> <批次数量> [输出目录]
// 例如: node split-usernames.js ../smart_usernames.txt 10 ./batches

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const batchCount = parseInt(process.argv[3]) || 10;
const outputDir = process.argv[4] || './batches';

if (!inputFile || !fs.existsSync(inputFile)) {
  console.log('用法: node split-usernames.js <输入文件> <批次数量> [输出目录]');
  console.log('例如: node split-usernames.js ../smart_usernames.txt 10 ./batches');
  process.exit(1);
}

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 读取所有用户名
const usernames = fs.readFileSync(inputFile, 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));

console.log(`📊 总用户名: ${usernames.length}`);
console.log(`📦 分割成 ${batchCount} 个批次`);

const batchSize = Math.ceil(usernames.length / batchCount);
console.log(`📏 每批大小: ~${batchSize}`);

// 分割并写入文件
for (let i = 0; i < batchCount; i++) {
  const start = i * batchSize;
  const end = Math.min(start + batchSize, usernames.length);
  const batch = usernames.slice(start, end);
  
  const outputFile = path.join(outputDir, `batch-${i}.txt`);
  fs.writeFileSync(outputFile, batch.join('\n'));
  
  console.log(`  batch-${i}.txt: ${batch.length} 个用户名`);
}

console.log(`\n✅ 完成! 文件保存在 ${outputDir}/`);

// 生成 GitHub Actions matrix 配置
const matrix = Array.from({ length: batchCount }, (_, i) => i);
console.log(`\nGitHub Actions matrix 配置:`);
console.log(`matrix:`);
console.log(`  batch: ${JSON.stringify(matrix)}`);
