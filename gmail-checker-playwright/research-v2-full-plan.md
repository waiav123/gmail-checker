# Gmail 用户名可用性检查 — 全量调研 v2（穷举式）

## 〇、现状评估

### 数据事实
- 已检查：~2558 个（000001-002557）
- 可用数：**0 个**（available.txt 为空）
- 占用率：**100%**（前 2558 个全部被占用）
- 剩余：~997,442 个
- 当前速度：~2 req/s（API 模式）
- 预计剩余时间：**~138 小时（5.75 天）** 不间断运行

### 关键洞察
6 位纯数字 Gmail 用户名的占用率极高。按当前趋势，100 万个中可用的可能极少。
这意味着：
1. **提速是刚需** — 不提速就是在浪费时间确认"全部占用"
2. **可以考虑抽样** — 先随机抽查 1000 个分散的号码，如果全占用，可能不需要全量扫描
3. **如果目标是"找到可用的"** — 应该优先扫描高号段（如 900000-999999），低号段被占概率更高

---

## 一、全量技术方案地图（穷举）

```
A. 注册流程方案（当前基线）
   A1. DOM 自动化 ← checker-auto.js ✅ 已实现
   A2. 浏览器内 XHR API ← checker-api-fast.js ✅ 已实现
   A3. 多浏览器上下文并行 ⚡ 可直接执行
   A4. 不同注册入口（移动端/桌面端/Workspace）🔬 值得测试
   A5. 移动端注册流程（不同 UA + URL）🔬 值得测试
   A6. 嵌入式注册（YouTube/Android 等入口）🔬 低优先级

B. 登录流程方案
   B1. 登录页 MI613e RPC ⭐ 高价值
   B2. 忘记密码流程 🔬 值得测试
   B3. 账号恢复流程 🔬 值得测试
   B4. Google One Tap / OAuth 发现 🔬 值得测试

C. 直接 HTTP 方案（脱离浏览器）
   C1. Cookie 导出 + node-fetch ⚡ 可直接执行
   C2. CDP 协议直接发请求 🔬 值得测试
   C3. curl-impersonate（模拟浏览器 TLS 指纹）⭐ 高价值
   C4. 本地代理抓包复用 ❌ 性价比低

D. Google 产品侧信道
   D1. Google Drive/Docs 共享对话框 ⭐ 高价值新方向
   D2. Google Contacts 导入检测 🔬 值得测试
   D3. Google Hangouts/Chat 用户查找 🔬 可能已失效
   D4. Google Groups 添加成员 🔬 值得测试
   D5. Google Pay 转账检测 🔬 复杂度高
   D6. Blogger/Sites 共享 🔬 类似 D1

E. Google Identity/Auth 平台
   E1. Identity Toolkit (identitytoolkit.googleapis.com) ⭐ 高价值
   E2. People API (people.googleapis.com) 🔬 需要 OAuth
   E3. Cloud Identity API 🔬 需要 Workspace
   E4. GCP IAM testIamPermissions 🔬 需要 GCP 项目
   E5. Firebase Auth createAuthUri 🔬 可能已被封堵

F. 邮件协议方案
   F1. SMTP RCPT TO ❌ 已测试，不可靠
   F2. 多 MX 服务器轮询 ❌ 共享后端
   F3. 发送邮件 + 退信分析 🔬 慢但独立通道
   F4. XMPP/Jabber（Google Talk 遗留）❌ 已关闭

G. 第三方/间接方案
   G1. 邮箱验证 API（Hunter.io 等）💰 有成本
   G2. Gravatar 头像检测 🔬 命中率低
   G3. 社交媒体关联查找 ❌ 不适用纯数字
   G4. 数据泄露库查询 ❌ 法律风险

H. 扩容/并行方案
   H1. 多 IP / 代理轮换 ⚡ 可直接执行
   H2. 多 Google 域名（.co.jp 等）🔬 值得测试
   H3. 浏览器池 ⚡ 可直接执行
   H4. 云函数分布式（AWS Lambda / GCP Functions）⚡ 可直接执行
   H5. 多 VPS 分布式 ⚡ 可直接执行
   H6. 住宅代理轮换 💰 有成本但效果好
   H7. 4G/5G 移动代理 💰 成本较高

I. 优化现有方案
   I1. 自适应速率控制 ⚡ 可直接执行
   I2. Session 池化 + 预热 ⚡ 可直接执行
   I3. 注册流程 + 登录流程交替使用 ⚡ 可直接执行
   I4. 减少不必要的等待时间 ⚡ 可直接执行
   I5. 智能抽样（先抽样判断占用率分布）⚡ 可直接执行

J. 策略优化（非技术）
   J1. 随机抽样 1000 个 → 估算总体占用率 ⚡ 立即执行
   J2. 分段扫描（先高号段，后低号段）⚡ 立即执行
   J3. 跳过已知高占用区间 ⚡ 立即执行
```

---

## 二、方案深度分析

### ⭐ Tier 0：策略优化（最高优先级，零成本）

#### J1. 随机抽样估算占用率

**核心问题：你真的需要扫描 100 万个吗？**

当前数据：前 2558 个全部占用。如果随机抽 1000 个分散号码（如 100000, 200000, 300000...），
发现占用率仍然 >99%，那全量扫描的 ROI 极低。

**执行方案：**
```
1. 从 all_numbers.txt 中随机抽取 1000 个（均匀分布在 0-999999）
2. 用现有 checker-api-fast.js 检查（约 8 分钟）
3. 统计占用率
4. 如果占用率 > 99%：考虑是否值得继续全量扫描
5. 如果占用率 < 95%：继续全量扫描，优先扫描低占用区间
```

**成本：** 8 分钟
**价值：** 可能节省 130+ 小时

#### J2. 分段扫描策略
- 高号段（800000-999999）可能占用率较低（注册较晚）
- 特殊号码（如 123456, 111111, 888888）几乎必定被占
- 可以先扫描高号段，找到可用的概率更大

---

### ⭐ Tier 1：可直接执行，高确定性

#### A3. 多浏览器上下文并行
**原理：** 同一浏览器实例开 N 个独立 context，每个走独立注册流程
**预期速度：** N × 2 req/s
**实现复杂度：** 低（改造 checker-api-fast.js）
**风险：** 同 IP 多 session 可能触发 IP 级限制
**建议测试：** 先 3 个 context，观察是否有额外限制

```javascript
// 伪代码
const contexts = await Promise.all([
  setupSession(browser),
  setupSession(browser),
  setupSession(browser),
]);
// 每个 context 负责 1/3 的用户名
```

#### I1. 自适应速率控制
**原理：** 动态调整请求间隔，从 500ms 开始，无降级则逐步缩短
**实现：**
```
初始间隔: 500ms
无降级连续 20 个: 间隔 -= 50ms（最低 150ms）
出现降级: 间隔 += 100ms，等 2s 重试
连续 3 次降级: 间隔重置为 500ms
```
**预期收益：** 可能从 2 req/s 提升到 3-5 req/s

#### I2. Session 池化 + 预热
**原理：** 后台维护 N 个就绪 session，主线程用完一个立即切换
**解决的问题：** 当前 session 刷新需要 15-20s，期间完全停工
**实现：**
```
- 维护 session 池（大小 3）
- 后台线程持续预热新 session
- 当前 session 降级 → 立即切换到池中下一个
- 旧 session 丢弃，后台补充新的
```
**预期收益：** 消除 session 刷新的停工时间

#### I4. 减少等待时间
当前 checker-api-fast.js 中有多处保守等待：
- `waitForTimeout(4000)` 填名字后 → 可以改为 `waitForNavigation` 或缩短到 2000
- `waitForTimeout(3000)` 页面加载 → 可以用 `waitForSelector` 替代
- `waitForTimeout(500)` 各种操作间 → 可以缩短到 200-300

**预期收益：** session 建立时间从 ~20s 缩短到 ~10s

---

### ⭐ Tier 2：高价值新方向，需要验证

#### B1. 登录页 MI613e RPC
**原理：** Google 登录页输入邮箱时，后端调用 MI613e RPC 检查账号是否存在
**优势：**
- 不需要走注册流程（省去姓名、生日填写，session 建立快 3x）
- 登录和注册是不同的服务，**限速池可能独立**
- 可以和注册流程并行运行 = 理论 2x 吞吐

**实现步骤：**
```
1. 打开 https://accounts.google.com/signin
2. 拦截请求，找到 MI613e 的 batchexecute 调用
3. 提取 XSRF + TL token
4. 构造最小请求
5. 解析响应：
   - "找不到您的 Google 账号" → 可用
   - 跳转到密码页 → 已占用
6. 测试速率限制
```

**风险：** 登录页可能更容易触发 reCAPTCHA
**成本：** ~2 小时实现

#### E1. Google Identity Toolkit
**原理：** `identitytoolkit.googleapis.com` 是 Google 的身份验证后端
**关键端点：**
```
POST https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri
Body: {
  "identifier": "000001@gmail.com",
  "continueUri": "http://localhost",
  "providerId": "google.com"
}
Header: x-goog-api-key: [Firebase API Key]
```

**响应差异：**
- 账号存在：返回 `{ "registered": true, "sessionId": "...", ... }`
- 账号不存在：返回 `{ "registered": false, ... }` 或错误

**关键问题：**
- 2023 年 9 月 Google 宣布弃用 `fetchSignInMethodsForEmail`（邮箱枚举保护）
- 但 `createAuthUri` 可能仍然泄露 `registered` 字段
- 需要一个 Firebase 项目的 API Key（免费创建）

**测试步骤：**
```
1. 创建 Firebase 项目，获取 Web API Key
2. 用 curl 测试：
   curl -X POST "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"identifier":"test@gmail.com","continueUri":"http://localhost"}'
3. 对比存在/不存在的响应
4. 如果能区分 → 测试速率限制
```

**如果可行：**
- 纯 HTTP 请求，无需浏览器
- 可以高并发（10-50 req/s per API key）
- 可以创建多个 Firebase 项目 = 多个 API key = 线性扩容
- **这可能是最快的路径**

**风险：** Google 可能已经封堵了这个信息泄露

#### C3. curl-impersonate
**原理：** curl-impersonate 是一个修改版 curl，完美模拟 Chrome 的 TLS 指纹
**优势：**
- 无需浏览器，纯命令行
- TLS 指纹和真实 Chrome 一致
- 可以高并发

**实现：**
```
1. 用 Playwright 建立一个 session，提取所有 cookies + tokens
2. 用 curl-impersonate 发送 NHJMOd 请求
3. 如果 Google 不检测 TLS 指纹以外的东西 → 成功
4. 可以用 Node.js 的 child_process 调用 curl-impersonate
```

**Windows 兼容性：** curl-impersonate 主要支持 Linux/macOS，Windows 需要 WSL
**替代方案：** 用 `undici` + 自定义 TLS 配置，或 `got` + `https-proxy-agent`

#### D1. Google Drive 共享检测
**原理：** 通过 Google Drive API 尝试共享文件给目标邮箱，根据响应判断用户是否存在
**实现：**
```
1. 创建 Google Cloud 项目，启用 Drive API
2. 创建 OAuth 凭据，获取 access_token
3. 创建一个测试文件
4. 尝试添加权限：
   POST https://www.googleapis.com/drive/v3/files/{fileId}/permissions
   Body: { "type": "user", "role": "reader", "emailAddress": "000001@gmail.com" }
   Query: sendNotificationEmail=false
5. 观察响应：
   - 用户存在：200 OK
   - 用户不存在：可能 404 或特定错误
```

**优势：**
- 完全不同的 API 和限速池
- 有官方 API，不需要逆向
- 可以用 Service Account 自动化

**风险：**
- Google 可能对不存在的邮箱也返回 200（静默失败）
- Drive API 有自己的配额限制（默认 12,000 请求/分钟）
- 需要 OAuth 认证

**成本：** ~2 小时实现 + 测试

---

### 🟡 Tier 3：值得测试但不确定性较高

#### B2. 忘记密码流程
**原理：** 忘记密码页输入邮箱 → 不存在会报错
**RPC：** 可能是不同的 RPC endpoint
**优势：** 又一个独立的限速池
**实现：** 类似 B1，需要抓包分析

#### B4. Google OAuth 发现
**原理：** OAuth 2.0 的 authorization endpoint 在处理 `login_hint` 参数时可能泄露用户存在性
```
GET https://accounts.google.com/o/oauth2/v2/auth?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=http://localhost&
  response_type=code&
  scope=email&
  login_hint=000001@gmail.com
```
**观察：** 页面行为是否因用户存在/不存在而不同

#### H2. 多 Google 域名
**测试：** `accounts.google.co.jp`, `accounts.google.co.uk` 等是否有独立限速
```
// 测试脚本
const domains = ['google.com', 'google.co.jp', 'google.co.uk', 'google.de', 'google.fr'];
for (const domain of domains) {
  // 用相同的方法在不同域名上测试
}
```

#### A4. 不同注册入口
**测试不同的 flowName：**
```
flowName=GlifWebSignIn          ← 当前
flowName=GlifWebSignIn&flowEntry=AddSession
flowName=GlifWebSignIn&flowEntry=ServiceLogin
// 移动端
flowName=GlifWebSignIn&flowEntry=SignUp&ifkv=xxx（移动端参数）
```

#### D2. Google Contacts 导入
**原理：** Google Contacts 有"查找联系人"功能，可能泄露邮箱存在性
**实现：** 通过 People API 的 `searchContacts` 或 `searchDirectoryPeople`

---

### 🔴 Tier 4：明确不可行或性价比极低

| 方案 | 原因 |
|------|------|
| F1. SMTP RCPT TO | 已测试，Google 返回不可靠结果，连接级限速极严 |
| F2. 多 MX 轮询 | 所有 MX 共享后端，无意义 |
| F4. XMPP/Jabber | Google Talk 已关闭，XMPP 网关已下线 |
| G3. 社交媒体查找 | 6 位纯数字用户名不太可能有社交媒体关联 |
| G4. 数据泄露库 | 法律风险高，数据不完整 |
| E2. Calendar 共享 | 操作复杂，速度极慢（需要创建事件+邀请+检查） |
| E3. Google Chat | 需要 Workspace 认证，API 限制严格 |
| D5. Google Pay | 需要已认证的支付账号，操作复杂 |
| G2. Gravatar | 6 位数字用户名几乎不可能有 Gravatar 头像 |

---

## 三、推荐执行路线

### Phase 0：智能决策（30 分钟）
```
目标：确定是否值得全量扫描
步骤：
1. 从 all_numbers.txt 随机抽取 500 个号码（均匀分布）
2. 额外抽取 500 个高号段（800000-999999）
3. 用 checker-api-fast.js 检查这 1000 个
4. 分析占用率分布
5. 决策：
   - 全部占用 → 考虑放弃全量扫描，或只扫描特定区间
   - 有可用的 → 继续，优先扫描低占用区间
```

### Phase 1：提速现有方案（2-3 小时）
```
目标：从 2 req/s → 8-12 req/s
步骤：
1. [I1] 实现自适应速率控制（30 min）
2. [I4] 优化等待时间（30 min）
3. [A3] 实现 3 context 并行（1 hour）
4. [I2] 实现 session 池化（1 hour）
预期效果：3 context × 3 req/s = ~9 req/s
剩余时间：~30 小时
```

### Phase 2：开辟新通道（3-4 小时）
```
目标：验证独立限速池，叠加吞吐
步骤：
1. [E1] 测试 Identity Toolkit endpoint（1 hour）
   → 如果可行：可能直接解决问题（50+ req/s）
2. [B1] 实现登录页 MI613e 检查器（2 hours）
   → 和注册流程并行 = 额外 3-6 req/s
3. [D1] 测试 Drive API 共享检测（1 hour）
   → 如果可行：又一个独立通道
预期效果：叠加后 15-20 req/s
剩余时间：~14 小时
```

### Phase 3：规模化（如果需要）
```
目标：30+ req/s
步骤：
1. [C3] 测试 curl-impersonate 脱离浏览器（2 hours）
2. [H1] 接入代理轮换（1 hour）
   - 每个 IP 独立限速
   - 5 个 IP × 10 req/s = 50 req/s
3. [H4] 云函数分布式（2 hours）
   - AWS Lambda / GCP Cloud Functions
   - 每个函数实例独立 IP
预期效果：50-100 req/s
剩余时间：~3 小时
```

---

## 四、各方案速度/成本/风险矩阵

| 方案 | 预期速度 | 实现成本 | 运行成本 | 风险 | 确定性 |
|------|---------|---------|---------|------|--------|
| 现有 A2 | 2 req/s | ✅ 已完成 | $0 | 低 | ✅ 确定 |
| I1 自适应速率 | 3-5 req/s | 30 min | $0 | 低 | ✅ 高 |
| A3 多 context | 6-10 req/s | 1 hour | $0 | 中 | 🟡 中高 |
| I2 session 池 | +30% 效率 | 1 hour | $0 | 低 | ✅ 高 |
| B1 登录页 API | +3-6 req/s | 2 hours | $0 | 中 | 🟡 中 |
| E1 Identity Toolkit | 10-50 req/s | 1 hour | $0 | 高 | 🔴 低（可能已封） |
| C3 curl-impersonate | 20-50 req/s | 3 hours | $0 | 中 | 🟡 中 |
| D1 Drive API | 5-20 req/s | 2 hours | $0 | 中 | 🟡 中 |
| H1 代理轮换 | N × 基础速度 | 1 hour | $5-20/天 | 低 | ✅ 高 |
| H4 云函数 | 50-200 req/s | 3 hours | $1-5/天 | 低 | ✅ 高 |

---

## 五、快速验证脚本（可直接执行）

### 5.1 Identity Toolkit 探测
```javascript
// test-identity-toolkit.js
// 需要先创建 Firebase 项目获取 API Key
const API_KEY = 'YOUR_FIREBASE_API_KEY';

async function checkEmail(email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: email,
        continueUri: 'http://localhost'
      })
    }
  );
  return await res.json();
}

// 测试
(async () => {
  console.log('存在的账号:', await checkEmail('test@gmail.com'));
  console.log('不存在的账号:', await checkEmail('dhjfkjshfk234hjkdhkh@gmail.com'));
})();
```

### 5.2 随机抽样脚本
```javascript
// sample-check.js
// 从 all_numbers.txt 随机抽取 N 个进行检查
const fs = require('fs');
const all = fs.readFileSync('all_numbers.txt', 'utf-8')
  .split('\n').filter(s => s.trim());

function sample(arr, n) {
  const result = [];
  const copy = [...arr];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result.sort();
}

const sampled = sample(all, 1000);
fs.writeFileSync('sample_numbers.txt', sampled.join('\n'));
console.log(`已抽取 ${sampled.length} 个样本`);
console.log(`范围: ${sampled[0]} - ${sampled[sampled.length-1]}`);
```

### 5.3 登录页 API 抓包脚本
```javascript
// capture-login-api.js
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const captured = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('batchexecute')) {
      captured.push({
        url: req.url(),
        postData: req.postData(),
        headers: req.headers()
      });
    }
  });

  page.on('response', async res => {
    if (res.request().method() === 'POST' && res.url().includes('batchexecute')) {
      const entry = captured.find(e => e.url === res.url() && !e.response);
      if (entry) {
        entry.response = await res.text().catch(() => '');
        entry.status = res.status();
      }
    }
  });

  // 打开登录页
  await page.goto('https://accounts.google.com/signin');
  await page.waitForTimeout(3000);

  // 输入一个不存在的邮箱
  const input = page.locator('input[type="email"]');
  await input.fill('dhjfkjshfk234hjkdhkh@gmail.com');
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(5000);

  console.log('=== 不存在的账号 ===');
  for (const c of captured) {
    if (c.response) {
      console.log(`URL: ${c.url.substring(0, 100)}`);
      console.log(`Response: ${c.response.substring(0, 300)}`);
    }
  }

  // 清空，测试存在的账号
  captured.length = 0;
  await page.goto('https://accounts.google.com/signin');
  await page.waitForTimeout(3000);
  await page.locator('input[type="email"]').fill('test@gmail.com');
  await page.locator('button:has-text("下一步"), button:has-text("Next")').click();
  await page.waitForTimeout(5000);

  console.log('\n=== 存在的账号 ===');
  for (const c of captured) {
    if (c.response) {
      console.log(`URL: ${c.url.substring(0, 100)}`);
      console.log(`Response: ${c.response.substring(0, 300)}`);
    }
  }

  await browser.close();
}

main().catch(console.error);
```

---

## 六、风险评估

### IP 封禁风险
- **当前风险：低** — 单 IP 2 req/s 在 Google 的容忍范围内
- **多 context 并行：中** — 同 IP 多 session 可能触发 IP 级限制
- **代理轮换：低** — 每个 IP 独立，风险分散
- **缓解措施：** 使用住宅代理（非数据中心 IP），模拟真实用户行为

### Google 账号封禁风险
- 当前方案不需要登录 Google 账号
- Drive API 方案需要 OAuth → 账号可能被标记
- **缓解：** 使用一次性 Google 账号

### 法律/合规风险
- Google ToS 禁止自动化访问
- 但这是公开的注册页面，不涉及数据窃取
- 风险等级：低（最坏情况是 IP 被封）

### 技术风险
- Google 随时可能改变注册流程/API 格式
- Session 降级机制可能变得更严格
- reCAPTCHA 可能更频繁触发
- **缓解：** 保持 DOM 自动化作为兜底方案

---

## 七、时间线估算

| 场景 | 速度 | 完成时间 | 所需投入 |
|------|------|---------|---------|
| 现状不变 | 2 req/s | ~138 小时 | 0 |
| Phase 1 完成 | 9 req/s | ~30 小时 | 3 小时开发 |
| Phase 1+2 完成 | 15-20 req/s | ~14-18 小时 | 6 小时开发 |
| Phase 1+2+3 完成 | 50+ req/s | ~5 小时 | 10 小时开发 + $10 运行成本 |
| Identity Toolkit 可行 | 50 req/s | ~5 小时 | 1 小时开发 |
| 随机抽样发现全占用 | N/A | 30 分钟 | 0 |

---

## 八、立即行动清单

**优先级从高到低：**

1. ⚡ **随机抽样**（30 min）— 决定是否值得继续
2. ⚡ **Identity Toolkit 探测**（30 min）— 可能是银弹
3. ⚡ **自适应速率 + 减少等待**（1 hour）— 确定性提速
4. ⚡ **多 context 并行**（1 hour）— 确定性 3x 提速
5. 🔬 **登录页 API 抓包**（1 hour）— 开辟新通道
6. 🔬 **Drive API 共享测试**（1 hour）— 独立通道
7. 🔬 **curl-impersonate 测试**（2 hours）— 脱离浏览器
8. 💰 **代理轮换接入**（1 hour + $）— 线性扩容
