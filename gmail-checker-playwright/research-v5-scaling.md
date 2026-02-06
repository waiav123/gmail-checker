# 极限规模化研究 v5：免费、全自动、可扩展方案

## 研究时间: 2026-02-06

## 约束条件
- ✅ 必须免费
- ✅ 必须全自动（无人工介入）
- ✅ 必须可扩展

---

## 一、当前瓶颈分析

### 核心限制
| 限制因素 | 当前值 | 说明 |
|---------|--------|------|
| 单 IP 限速 | ~3-4 req/s | Google IP 级限速，无法绕过 |
| 浏览器开销 | ~20s/session | 建立 session 需要完整页面加载 |
| 降级恢复 | 1.5-7.5s | 降级后需要退避等待 |

### 关键洞察
**唯一的规模化路径是：获取更多独立 IP**

每个独立 IP 可以稳定跑 ~3-4 req/s，所以：
- 10 个 IP = 30-40 req/s
- 100 个 IP = 300-400 req/s

---

## 二、免费 IP 来源分析

### 方案 1：GitHub Actions（最有潜力）

**原理：** GitHub Actions 每个 job 运行在独立的 Azure VM 上，有独立 IP。

**免费额度：**
- 公开仓库：无限制
- 私有仓库：2000 分钟/月

**并发限制：**
- 免费账户：20 个并发 job
- 每个 job 独立 IP

**理论速度：** 20 job × 3 req/s = **60 req/s**

**优势：**
- 完全免费（公开仓库）
- 全自动（workflow 触发）
- 每次运行都是新 IP
- 无需维护服务器

**挑战：**
- 需要安装 Playwright（每次 ~2 分钟）
- Job 最长运行 6 小时
- 需要协调多 job 结果

**可行性：⭐⭐⭐⭐⭐**

---

### 方案 2：Oracle Cloud 永久免费层

**免费资源：**
- 2 个 AMD VM（1 OCPU, 1GB RAM）
- 4 个 ARM VM（共 24GB RAM, 4 OCPU）
- 永久免费，不会过期

**理论速度：** 6 VM × 3 req/s = **18 req/s**

**优势：**
- 永久免费
- 独立 IP
- 可以 24/7 运行

**挑战：**
- 需要信用卡验证（不扣费）
- 需要手动设置一次
- 资源有限

**可行性：⭐⭐⭐⭐**

---

### 方案 3：Google Cloud Shell

**免费资源：**
- 每周 50 小时
- 临时 VM，有独立 IP

**限制：**
- 需要交互（20 分钟无操作断开）
- 不能后台运行

**可行性：⭐⭐（需要保持活跃）**

---

### 方案 4：Replit / Gitpod / CodeSandbox

**免费资源：**
- Replit: 免费 Repl 有限资源
- Gitpod: 50 小时/月
- CodeSandbox: 有限免费

**限制：**
- 资源受限
- 可能共享 IP
- 不适合长时间运行

**可行性：⭐⭐**

---

### 方案 5：Tor 网络

**原理：** 通过 Tor 获取不同出口节点 IP

**问题：**
- Google 封锁大部分 Tor 出口节点
- 速度极慢
- 不稳定

**可行性：⭐（基本不可用）**

---

### 方案 6：免费代理池

**来源：**
- free-proxy-list.net
- pubproxy.com
- 各种免费代理 API

**问题：**
- 质量极差（90%+ 不可用）
- 速度慢
- 大部分被 Google 封锁
- 不稳定

**可行性：⭐（不推荐）**

---

## 三、推荐方案：GitHub Actions 分布式架构

### 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    本地协调器                            │
│  - 分发用户名到各 job                                    │
│  - 收集结果                                              │
│  - 监控进度                                              │
└─────────────────────────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Job 1    │    │ Job 2    │    │ Job N    │
    │ IP: A    │    │ IP: B    │    │ IP: N    │
    │ 3 req/s  │    │ 3 req/s  │    │ 3 req/s  │
    └──────────┘    └──────────┘    └──────────┘
           │               │               │
           └───────────────┼───────────────┘
                           ▼
                    GitHub Artifacts
                    (结果文件存储)
```

### 工作流程

1. **本地准备：**
   - 将用户名列表分割成 N 份
   - 上传到 GitHub 仓库

2. **触发 Workflow：**
   - 使用 matrix 策略启动 N 个并行 job
   - 每个 job 处理一份用户名

3. **Job 执行：**
   - 安装 Playwright
   - 运行 checker
   - 上传结果到 Artifacts

4. **结果收集：**
   - 下载所有 Artifacts
   - 合并结果

### Workflow 配置示例

```yaml
name: Gmail Checker Distributed

on:
  workflow_dispatch:
    inputs:
      batch_count:
        description: 'Number of parallel batches'
        default: '10'

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        batch: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      fail-fast: false
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: |
          cd gmail-checker-playwright
          npm install
          npx playwright install chromium
      
      - name: Run checker
        run: |
          cd gmail-checker-playwright
          node checker-distributed.js batch-${{ matrix.batch }}.txt
        timeout-minutes: 300
      
      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: results-${{ matrix.batch }}
          path: |
            gmail-checker-playwright/available.txt
            gmail-checker-playwright/failed.txt
```

### 预期性能

| 配置 | 并发 Job | 单 Job 速度 | 总速度 | 每小时处理量 |
|------|---------|------------|--------|-------------|
| 保守 | 5 | 3 req/s | 15 req/s | 54,000 |
| 标准 | 10 | 3 req/s | 30 req/s | 108,000 |
| 激进 | 20 | 3 req/s | 60 req/s | 216,000 |

**100 万用户名处理时间：**
- 保守：~18.5 小时
- 标准：~9.3 小时
- 激进：~4.6 小时

---

## 四、混合方案：本地 + GitHub Actions + Oracle

### 资源组合

| 来源 | IP 数量 | 速度 | 说明 |
|------|--------|------|------|
| 本地 | 1 | 3-4 req/s | 当前实现 |
| GitHub Actions | 20 | 60 req/s | 并行 job |
| Oracle Free | 6 | 18 req/s | 永久免费 VM |
| **总计** | **27** | **~80 req/s** | |

### 每小时处理量：288,000 个用户名
### 100 万用户名：~3.5 小时

---

## 五、实现计划

### Phase 1：GitHub Actions 基础版（1-2 小时）

1. 创建 `checker-distributed.js`（适配 GitHub Actions 环境）
2. 创建 `.github/workflows/gmail-checker.yml`
3. 创建用户名分割脚本
4. 测试单 job 运行

### Phase 2：并行扩展（30 分钟）

1. 实现 matrix 策略多 job 并行
2. 实现结果合并脚本
3. 测试 10 job 并行

### Phase 3：Oracle Cloud 补充（可选，1 小时）

1. 注册 Oracle Cloud 账户
2. 创建免费 VM
3. 部署 checker
4. 设置自动运行

### Phase 4：协调器优化（可选）

1. 实现智能任务分配
2. 实现实时进度监控
3. 实现失败重试

---

## 六、风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| GitHub 封禁仓库 | 低 | 高 | 使用私有仓库，控制频率 |
| Google 封锁 GitHub IP 段 | 中 | 高 | 降低单 job 速度，增加随机延迟 |
| Workflow 超时 | 低 | 中 | 分批处理，保存进度 |
| 结果丢失 | 低 | 中 | 定期上传 Artifacts |

---

## 七、结论

**最佳方案：GitHub Actions 分布式**

- ✅ 完全免费
- ✅ 全自动
- ✅ 可扩展到 60+ req/s
- ✅ 无需维护服务器
- ✅ 每次运行都是新 IP

**下一步：实现 GitHub Actions workflow 和分布式 checker**
