# Gmail 用户名检查器

自动检查 Gmail 用户名可用性，支持本地单机和 GitHub Actions 分布式两种模式。

## 安装

```bash
cd gmail-checker-playwright
npm install
npx playwright install chromium
```

## 三种运行方式

### 方式 1：本地并发版（推荐本地使用）

3 个并发 context 共享一个浏览器，单机最优方案。

```bash
node local-parallel/checker-parallel.js <用户名文件> [context数量]
# 例如: node local-parallel/checker-parallel.js ../smart_usernames.txt 3
```

- 速度：~2-2.5 req/s（单 IP 上限 ~3-4 req/s）
- 适合：小批量测试、调试

### 方式 2：本地精简版

单 context，最基础稳定的版本。

```bash
node local-single/checker-api-fast.js <用户名文件>
# 或
node local-single/checker-auto.js <用户名文件>
```

- 速度：~1-1.5 req/s
- 适合：最稳定的单线程检查

### 方式 3：GitHub Actions 分布式（推荐大批量）

40 个 job 分两轮跑（每轮 20 并发），每个 job 独立 IP，全自动无人值守。

```bash
# 1. 分割用户名文件为 40 个批次
node split-usernames.js <用户名文件> 40 ./batches

# 2. 提交到 GitHub
git add . && git commit -m "setup batches" && git push

# 3. 去 GitHub Actions 页面手动触发 "Gmail Username Checker"

# 4. 等待完成，结果自动提交到仓库 results/ 目录
```

- 速度：理论 ~40 req/s（20 IP × 2/s）
- 适合：大批量（数十万用户名），全自动
- 结果：自动合并并提交到 `results/` 目录

#### GitHub 仓库设置要求

触发前需确保：
1. Settings → Actions → General → Workflow permissions → **Read and write permissions**
2. 点 Save

## 性能对比

| 方案 | 速度 | 每小时处理量 | 适用场景 |
|------|------|-------------|---------|
| 本地精简版 | ~1-1.5/s | ~5,000 | 小规模测试 |
| 本地并发版 | ~2-2.5/s | ~9,000 | 中等规模 |
| GitHub Actions 40 job | ~40/s | ~144,000 | 大规模 |

## 目录结构

```
gmail-checker-playwright/
├── checker-distributed.js      # 方式3：分布式主程序
├── merge-results.js            # 方式3：结果合并脚本
├── setup-distributed.js        # 方式3：session 设置
├── split-usernames.js          # 方式3：批次分割工具
├── batches/                    # 方式3：40个批次文件
├── local-parallel/             # 方式1：本地多并发版
│   └── checker-parallel.js
├── local-single/               # 方式2：本地单机精简版
│   ├── checker-api-fast.js
│   ├── checker-auto.js
│   └── capture-*.js
├── research/                   # 调研文档和脚本
├── tests/                      # 测试脚本
├── package.json
└── README.md
```

## 输出文件

| 文件 | 说明 |
|------|------|
| `available.txt` | 可用的用户名 |
| `failed.txt` | 不可用的用户名及原因 |
| `degraded.txt` | 降级未确认的用户名（可重试） |
| `progress.json` | 进度文件（支持断点续查） |
| `summary.json` | 合并后的统计摘要 |

## 功能特性

- 自动填写 Google 注册流程（姓名、生日、性别）
- 探针校验确保检测环境正常
- Ctrl+C 安全退出，自动保存进度，支持断点续查
- 自适应调速：降级时自动减速，恢复后加速
- Session 自动刷新：连续降级/错误时重建 session
- 降级用户名单独记录，不与失败混淆
- 环境变量 `REQUEST_DELAY` 控制请求间隔
