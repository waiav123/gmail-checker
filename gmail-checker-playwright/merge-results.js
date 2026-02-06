// 结果合并脚本 - 合并多个批次的结果
// 用法: node merge-results.js <结果目录> [输出目录]
// 例如: node merge-results.js ./results ./final

const fs = require('fs');
const path = require('path');

const resultsDir = process.argv[2] || './results';
const outputDir = process.argv[3] || './final';

if (!fs.existsSync(resultsDir)) {
  console.log(`错误: 结果目录不存在: ${resultsDir}`);
  process.exit(1);
}

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const availableSet = new Set();
const failedSet = new Set();
let totalProgress = { totalChecked: 0, availableCount: 0, failedCount: 0 };

// 遍历所有子目录
const subdirs = fs.readdirSync(resultsDir).filter(f => {
  const fullPath = path.join(resultsDir, f);
  return fs.statSync(fullPath).isDirectory();
});

console.log(`📁 找到 ${subdirs.length} 个结果目录`);

for (const subdir of subdirs) {
  const subdirPath = path.join(resultsDir, subdir);
  
  // 读取 available.txt
  const availableFile = path.join(subdirPath, 'available.txt');
  if (fs.existsSync(availableFile)) {
    const lines = fs.readFileSync(availableFile, 'utf-8').split('\n').filter(s => s.trim());
    lines.forEach(l => availableSet.add(l.trim()));
  }
  
  // 读取 failed.txt
  const failedFile = path.join(subdirPath, 'failed.txt');
  if (fs.existsSync(failedFile)) {
    const lines = fs.readFileSync(failedFile, 'utf-8').split('\n').filter(s => s.trim());
    lines.forEach(l => failedSet.add(l.trim()));
  }
  
  // 读取 progress.json
  const progressFile = path.join(subdirPath, 'progress.json');
  if (fs.existsSync(progressFile)) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      totalProgress.totalChecked += progress.totalChecked || 0;
    } catch {}
  }
  
  console.log(`  ${subdir}: ✅${availableSet.size - totalProgress.availableCount} ❌${failedSet.size - totalProgress.failedCount}`);
  totalProgress.availableCount = availableSet.size;
  totalProgress.failedCount = failedSet.size;
}

// 写入合并结果
const finalAvailable = path.join(outputDir, 'available.txt');
const finalFailed = path.join(outputDir, 'failed.txt');
const finalSummary = path.join(outputDir, 'summary.json');

fs.writeFileSync(finalAvailable, Array.from(availableSet).join('\n'));
fs.writeFileSync(finalFailed, Array.from(failedSet).join('\n'));
fs.writeFileSync(finalSummary, JSON.stringify({
  totalChecked: totalProgress.totalChecked,
  availableCount: availableSet.size,
  failedCount: failedSet.size,
  mergedAt: new Date().toISOString(),
  sources: subdirs.length
}, null, 2));

console.log('\n' + '='.repeat(50));
console.log(`✅ 可用: ${availableSet.size}`);
console.log(`❌ 失败: ${failedSet.size}`);
console.log(`📊 总计: ${totalProgress.totalChecked}`);
console.log('='.repeat(50));
console.log(`\n结果保存在 ${outputDir}/`);

// 显示可用用户名
if (availableSet.size > 0) {
  console.log('\n🎉 可用用户名:');
  Array.from(availableSet).slice(0, 20).forEach(u => console.log(`  ${u}@gmail.com`));
  if (availableSet.size > 20) {
    console.log(`  ... 还有 ${availableSet.size - 20} 个`);
  }
}
