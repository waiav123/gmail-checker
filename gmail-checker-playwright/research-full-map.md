# Gmail 用户名可用性检查 — 全量技术方案地图

## 一、方案总览

```
A. 注册流程方案（当前）
   A1. DOM 自动化 ← checker-auto.js
   A2. 浏览器内 XHR API ← checker-api-fast.js（已优化）
   A3. 多浏览器上下文并行
   A4. 不同注册入口（移动端/桌面端）

B. 登录流程方案（新发现）
   B1. 登录页 MI613e RPC — 检测账号是否存在
   B2. 忘记密码流程

C. 直接 HTTP 方案（脱离浏览器）
   C1. 提取 httpOnly cookies 后独立发请求
   C2. CDP 协议提取完整 cookie jar
   C3. 本地代理抓包复用

D. SMTP 协议方案
   D1. RCPT TO 验证
   D2. 多 MX 服务器轮询

E. Google API 方案
   E1. Google People API
   E2. Google Calendar 共享检测
   E3. Google Chat/Hangouts 查找
   E4. GMS (Android) 接口

F. 第三方服务
   F1. 邮箱验证 API（Hunter.io 等）
   F2. SMTP 验证服务

G. 扩容方案
   G1. 多 IP / 代理轮换
   G2. 多 Google 域名（.co.jp, .co.uk 等）
   G3. 浏览器池
```

## 二、逐方案深度分析

---

### A1. DOM 自动化（当前 checker-auto.js）
- 状态：✅ 已实现，可用
- 速度：~1 req/s（含页面跳转等待）
- 优点：最可靠，和真人行为一致
- 缺点：慢，每次检查需要 DOM 交互 + 页面跳转
- 降级风险：低（真实浏览器行为）
- 适用：兜底方案

### A2. 浏览器内 XHR API（当前 checker-api-fast.js）
- 状态：✅ 已实现并优化
- 速度：~2 req/s（500ms 间隔）
- 优点：比 DOM 快 2x，响应解析精确
- 缺点：session 会降级（[null,[]] 响应）
- 降级风险：中（速率敏感，500ms 间隔可控）
- 适用：主力方案

### A3. 多浏览器上下文并行
- 状态：⚡ 可直接执行
- 原理：同一浏览器开多个 context，每个走独立注册流程
- 预期速度：N × 2 req/s（N 个 context）
- 风险：同 IP 多 session 可能触发 Google 的 IP 级限制
- 成本：内存占用增加
- 值得测试：3-5 个 context 并行

### A4. 不同注册入口
- 状态：🔬 值得测试
- 思路：移动端注册 URL、不同 flowName、Workspace 注册
- 可能的入口：
  - `flowName=GlifWebSignIn` （当前）
  - `flowName=GlifWebSignIn&flowEntry=AddSession`
  - 移动端 UA + 移动端注册 URL
  - Google Workspace 试用注册
- 价值：不同入口可能有不同的限速策略

---

### B1. 登录页 MI613e RPC（⭐ 高价值新方向）
- 状态：🔬 已验证可行，需深入测试
- 原理：登录页输入邮箱 → "找不到账号" = 用户名可用，跳转密码页 = 已存在
- RPC：`MI613e`（不同于注册的 `NHJMOd`）
- 优势：
  - 不需要走注册流程（省去姓名、生日、性别填写）
  - 登录页加载更快
  - 可能有不同的限速策略（登录 vs 注册是不同的服务）
- 风险：
  - 可能更容易触发 recaptcha
  - 不能区分"用户名可用"和"用户名格式错误"
- 实验结果：
  - `dhjfkjshfk234hjkdhkh@gmail.com` → "找不到您的 Google 账号"
  - `testuser@gmail.com` → 跳转到密码/验证页面
- 下一步：提取 MI613e 的最小请求格式，测试 API 调用

### B2. 忘记密码流程
- 状态：🔬 值得测试
- 原理：忘记密码页输入邮箱 → 不存在会报错
- 优势：可能限速策略不同
- 风险：和 B1 类似

---

### C1. 提取 httpOnly cookies 独立发请求
- 状态：🔬 值得测试
- 原理：用 CDP 协议提取浏览器的完整 cookie jar（包括 httpOnly），然后用 node-fetch 直接发请求
- 实现：`page.context().cookies()` 可以拿到所有 cookies
- 优势：脱离浏览器后可以用纯 HTTP 并发
- 风险：
  - Google 可能检测 TLS 指纹（浏览器 vs Node.js）
  - httpOnly cookies 可能绑定了浏览器指纹
- 成本：低，Playwright 原生支持 cookie 导出

### C2. CDP 协议直接操作
- 状态：🔬 值得测试
- 原理：通过 Chrome DevTools Protocol 直接发网络请求
- 优势：完全模拟浏览器的网络栈（TLS 指纹一致）
- 实现：`page.context().newCDPSession()` → `Network.enable` → 直接发请求

### C3. 本地代理抓包
- 状态：❌ 性价比低
- 原因：增加复杂度但不增加能力，不如 C1

---

### D1. SMTP RCPT TO 验证
- 状态：⚠️ 部分可行但严重受限
- 实验结果：
  - `test@gmail.com` → 550（不存在）— 但这个应该存在！
  - 后续请求 timeout — Google 限制了连接
- 问题：
  - Google 的 SMTP 服务器对 RCPT TO 的响应不可靠
  - 可能返回假阴性（存在的账号也返回 550）
  - 连接级限速极其严格（1 个连接只能查 1 个）
  - 需要干净的 IP（不在黑名单上）
- 结论：**不可靠，不推荐作为主方案**
- 但可以作为辅助验证（交叉验证注册 API 的结果）

### D2. 多 MX 服务器轮询
- 状态：❌ 不可行
- 原因：所有 MX 服务器共享同一后端，限速策略一致

---

### E1. Google People API
- 状态：❌ 不可行
- 原因：需要 OAuth 认证，只能查询已知联系人，不能检测任意邮箱是否存在

### E2. Google Calendar 共享检测
- 状态：🔬 理论可行但复杂
- 原理：创建日历事件，邀请目标邮箱，检查是否返回"用户不存在"
- 缺点：需要已登录的 Google 账号，操作复杂，速度慢
- 结论：性价比极低

### E3-E4. Google Chat / GMS
- 状态：❌ 不可行
- 原因：需要认证，API 限制严格

---

### F1. 第三方邮箱验证 API
- 状态：💰 可行但有成本
- 服务：Hunter.io, NeverBounce, ZeroBounce, Kickbox 等
- 价格：约 $0.003-0.01/次
- 优点：稳定、快速、不需要自己维护
- 缺点：
  - 有成本
  - 可能也是用 SMTP 验证（不可靠）
  - 部分服务对 Gmail 的准确率不高
- 适用：小批量验证或交叉验证

---

### G1. 多 IP / 代理轮换
- 状态：⚡ 可直接执行
- 原理：不同 IP 有独立的限速配额
- 实现：Playwright 支持 proxy 配置
- 成本：代理服务费用
- 效果：线性扩容

### G2. 多 Google 域名
- 状态：🔬 值得测试
- 思路：`accounts.google.co.jp`, `accounts.google.co.uk` 等
- 可能性：不同域名可能有独立的限速
- 风险：可能共享后端限速

### G3. 浏览器池
- 状态：⚡ 可直接执行
- 原理：预启动多个浏览器实例，每个维护独立 session
- 实现：Playwright 支持多实例
- 适用：配合代理轮换使用

## 三、方案优先级排序

### 🟢 Tier 1：可直接执行，高成功率
| 方案 | 预期速度 | 实现难度 | 风险 |
|------|---------|---------|------|
| A2 优化版（当前） | 2 req/s | ✅ 已完成 | 低 |
| A3 多 context 并行 | 6-10 req/s | 低 | 中 |
| B1 登录页 API | 2+ req/s | 中 | 中 |

### 🟡 Tier 2：值得测试，有不确定性
| 方案 | 预期收益 | 不确定性 |
|------|---------|---------|
| C1 cookie 导出 + 独立 HTTP | 高并发 | TLS 指纹检测 |
| A4 不同注册入口 | 不同限速 | 未知 |
| G2 多域名 | 扩容 | 可能共享限速 |
| B1+A2 交替使用 | 双倍配额 | 未知 |

### 🔴 Tier 3：不推荐
| 方案 | 原因 |
|------|------|
| D1 SMTP | 不可靠，严格限速 |
| E1-E4 Google API | 需要认证，不适用 |
| E2 Calendar | 太复杂，太慢 |
| F1 第三方 | 有成本，Gmail 准确率存疑 |

## 四、推荐执行路线

```
Phase 1（立即）：
  → A2 已完成，作为基线
  → A3 多 context 并行（预期 3x 提速）

Phase 2（短期）：
  → B1 登录页 API 调研（可能是独立限速池）
  → C1 cookie 导出测试（如果成功，可脱离浏览器高并发）

Phase 3（中期）：
  → G1 代理轮换（线性扩容）
  → A2+B1 交替使用（双倍配额假设）

Phase 4（如果需要更大规模）：
  → G3 浏览器池 + 代理
  → 多机器分布式
```
