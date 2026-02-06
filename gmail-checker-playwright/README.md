# Gmail 用户名检查器 - Playwright 版本

自动检查 Gmail 用户名可用性，智能识别页面状态，支持断点续查。

## 安装

```bash
cd gmail-checker-playwright
npm install
npx playwright install chromium
```

## 使用方法

### 本地单机版

```bash
# 单 context 版本
node checker-auto.js <用户名文件>

# 多 context 并行版本（推荐，单机最优）
node checker-parallel.js <用户名文件> [context数量]
# 例如: node checker-parallel.js ../smart_usernames.txt 2
```

### 分布式版本（GitHub Actions）

适合大规模检查，利用 GitHub Actions 的多 IP 并行能力。

```bash
# 1. 设置分布式检查
node setup-distributed.js <用户名文件> [批次数量]
# 例如: node setup-distributed.js ../smart_usernames.txt 10

# 2. 提交到 GitHub
git add .
git commit -m "Setup distributed checker"
git push

# 3. 在 GitHub Actions 页面手动触发 workflow

# 4. 下载结果后合并
node merge-results.js <下载的结果目录> ./final
```

## 性能对比

| 方案 | 速度 | 每小时处理量 | 适用场景 |
|------|------|-------------|---------|
| 单机单 context | ~2-3 req/s | ~10,000 | 小规模测试 |
| 单机多 context | ~3-4 req/s | ~14,000 | 中等规模 |
| GitHub Actions 5 job | ~15 req/s | ~54,000 | 大规模 |
| GitHub Actions 10 job | ~30 req/s | ~108,000 | 大规模 |
| GitHub Actions 20 job | ~60 req/s | ~216,000 | 超大规模 |

## 文件说明

### 检查器脚本
- `checker-auto.js` - 基础单 context 版本
- `checker-parallel.js` - 多 context 并行版本（单机最优）
- `checker-distributed.js` - GitHub Actions 分布式版本
- `checker-api-fast.js` - API 模式快速版本

### 工具脚本
- `setup-distributed.js` - 分布式检查快速设置
- `split-usernames.js` - 用户名文件分割
- `merge-results.js` - 结果合并

### 输出文件
- `available.txt` - 可用的用户名
- `failed.txt` - 不可用的用户名及原因
- `checker.log` / `checker-parallel.log` - 运行日志
- `progress.json` - 进度文件（分布式版本）

### 研究文档
- `research-v4-optimization.md` - 优化研究
- `research-v4-idt-results.md` - Identity Toolkit 研究结果
- `research-v5-scaling.md` - 规模化方案研究

## 功能特性

- 自动填写注册流程（姓名、生日、性别）
- 智能识别当前页面状态，自动恢复
- 探针校验确保检测环境正常
- Ctrl+C 安全退出，自动保存进度
- 已检查的用户名从源文件移除，支持断点续查
- 全局速率限制器，自适应调速
- 降级自动恢复，session 自动刷新
