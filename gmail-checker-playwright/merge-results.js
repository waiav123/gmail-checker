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
const degradedSet = new Set();
let totalProgress = { totalChecked: 0, availableCount: 0, failedCount: 0, degradedCount: 0 };

// 遍历所有子目录
const subdirs = fs.readdirSync(resultsDir).filter(f => {
  const fullPath = path.join(resultsDir, f);
  return fs.statSync(fullPath).isDirectory();
});

console.log(`📁 找到 ${subdirs.length} 个结果目录`);

for (const subdir of subdirs) {
  const subdirPath = path.join(resultsDir, subdir);
  let subdirAvailable = 0, subdirFailed = 0, subdirDegraded = 0;
  
  // 读取 available.txt
  const availableFile = path.join(subdirPath, 'available.txt');
  if (fs.existsSync(availableFile)) {
    const lines = fs.readFileSync(availableFile, 'utf-8').split('\n').filter(s => s.trim());
    lines.forEach(l => { if (!availableSet.has(l.trim())) subdirAvailable++; availableSet.add(l.trim()); });
  }
  
  // 读取 failed.txt（用 tab 前的用户名部分去重）
  const failedFile = path.join(subdirPath, 'failed.txt');
  if (fs.existsSync(failedFile)) {
    const lines = fs.readFileSync(failedFile, 'utf-8').split('\n').filter(s => s.trim());
    lines.forEach(l => {
      const username = l.trim().split('\t')[0];
      if (username && !failedSet.has(username)) subdirFailed++;
      if (username) failedSet.add(username);
    });
  }
  
  // 读取 degraded.txt
  const degradedFile = path.join(subdirPath, 'degraded.txt');
  if (fs.existsSync(degradedFile)) {
    const lines = fs.readFileSync(degradedFile, 'utf-8').split('\n').filter(s => s.trim());
    lines.forEach(l => { if (!degradedSet.has(l.trim())) subdirDegraded++; degradedSet.add(l.trim()); });
  }
  
  // 读取 progress.json
  const progressFile = path.join(subdirPath, 'progress.json');
  if (fs.existsSync(progressFile)) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      totalProgress.totalChecked += progress.totalChecked || 0;
    } catch {}
  }
  
  console.log(`  ${subdir}: ✅${subdirAvailable} ❌${subdirFailed} ⚠️${subdirDegraded}`);
}

// 写入合并结果
const finalAvailable = path.join(outputDir, 'available.txt');
const finalFailed = path.join(outputDir, 'failed.txt');
const finalDegraded = path.join(outputDir, 'degraded.txt');
const finalSummary = path.join(outputDir, 'summary.json');

fs.writeFileSync(finalAvailable, Array.from(availableSet).join('\n'));
fs.writeFileSync(finalFailed, Array.from(failedSet).join('\n'));
fs.writeFileSync(finalDegraded, Array.from(degradedSet).join('\n'));
fs.writeFileSync(finalSummary, JSON.stringify({
  totalChecked: totalProgress.totalChecked,
  availableCount: availableSet.size,
  failedCount: failedSet.size,
  degradedCount: degradedSet.size,
  mergedAt: new Date().toISOString(),
  sources: subdirs.length
}, null, 2));

console.log('\n' + '='.repeat(50));
console.log(`✅ 可用: ${availableSet.size}`);
console.log(`❌ 失败: ${failedSet.size}`);
console.log(`⚠️ 降级: ${degradedSet.size} (可重试)`);
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
