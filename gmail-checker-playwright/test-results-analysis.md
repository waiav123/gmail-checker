# 全量方案测试结果分析

## 测试时间: 2026-02-06

---

## 一、各方案测试结果

### ✅ 已验证可行（6 个）

| # | 方案 | 结果 | 可用于检测 | 备注 |
|---|------|------|-----------|------|
| 1 | **登录页 MI613e RPC** | ✅ 响应差异明确 | ✅ 是 | ⭐ 最有价值发现 |
| 2 | **忘记密码流程** | ✅ "找不到您的 Google 账号" | ✅ 是 | 独立通道 |
| 3 | **Cookie 导出** | ✅ 6 个 cookies 可导出 | 辅助 | 含 4 个 httpOnly |
| 4 | **CDP 协议** | ✅ 可获取完整 cookies | 辅助 | Network.enable 正常 |
| 5 | **多 context 并行** | ✅ 3 context 3.9s 全部加载 | ✅ 是 | 直接提速 3x |
| 6 | **注册流程 (现有)** | ✅ 已在运行 | ✅ 是 | 基线方案 |

### ⭐ 关键发现：登录页 MI613e 响应格式

**不存在的账号** (dhjfkjshfk234hjkdhkh@gmail.com):
```
Response 长度: 194 字节
内容: [null,null,null,...,null,[9]]
页面显示: "找不到您的 Google 账号"
```

**存在的账号** (000001@gmail.com):
```
Response 长度: 905 字节
内容: 包含 "LOGIN_CHALLENGE" 或 "FIRST_AUTH_FACTOR"
包含: 用户头像 URL, reCAPTCHA key
页面跳转到: /challenge/recaptcha 或 /challenge/pwd
```

**存在的账号** (999999@gmail.com):
```
Response 长度: 822 字节
内容: 包含 "FIRST_AUTH_FACTOR"
页面跳转到: /challenge/pwd
```

**判定规则:**
- Response 长度 < 300 且包含 `[9]` → 不存在
- Response 包含 `LOGIN_CHALLENGE` 或 `FIRST_AUTH_FACTOR` → 存在
- 页面 URL 包含 `/challenge/` → 存在

### ⚠️ 重要风险
- 000001@gmail.com 触发了 reCAPTCHA（"证明您不是自动程序"）
- test@gmail.com 也显示"找不到"（可能是 Google 的保护机制，对频繁查询的 IP 返回假阴性）
- 第 5 个测试时连接被 Google 断开（ERR_CONNECTION_CLOSED）→ IP 级限制

### ❌ 已验证不可行（12 个）

| # | 方案 | 结果 | 原因 |
|---|------|------|------|
| 1 | Identity Toolkit (无自有 Key) | 400/403 | 需要有效的 Firebase API Key |
| 2 | Google 域名变体 | 全部 301 重定向 | 所有域名重定向到 accounts.google.com |
| 3 | People API | 401 | 需要 OAuth |
| 4 | Contacts API | 403 | 需要认证 |
| 5 | Gravatar | 全部 404 | 6 位数字用户名无 Gravatar |
| 6 | Google+ / Profiles | Failed to fetch | 服务已关闭 |
| 7 | OAuth login_hint | 400 错误 | redirect_uri 无效，无法区分 |
| 8 | Google Chat/Hangouts | 401 | 需要 OAuth |
| 9 | GCP Cloud Identity | Failed to fetch | 需要认证 |
| 10 | Admin Directory | 401 | 需要 Workspace 管理员 |
| 11 | Calendar FreeBusy | 403 | 需要认证 |
| 12 | Drive API (无认证) | 401 | 需要 OAuth |

### 🔬 需要进一步测试（5 个）

| # | 方案 | 状态 | 下一步 |
|---|------|------|--------|
| 1 | Identity Toolkit (自有 Key) | 需要创建 Firebase 项目 | 创建项目获取 Key |
| 2 | Drive API 共享检测 | 需要 OAuth | 创建 GCP 项目 + OAuth |
| 3 | 邮件退信分析 | 需要 SMTP 服务器 | 配置发送服务器 |
| 4 | 第三方 API (disify) | 返回域名信息但不检测用户 | 测试其他服务 |
| 5 | 移动端注册 | 流程相同 | 测试是否有不同限速 |

### 注册入口变体结果

| 入口 | 结果 |
|------|------|
| flowEntry=AddSession | 跳转到登录页（不是注册） |
| flowEntry=ServiceLogin | 跳转到登录页 |
| 无 flowEntry | 跳转到登录页 |
| /SignUp 直接 | ✅ 正常注册流程 |
| service=wise | 正常注册流程 |
| service=mail | 正常注册流程 |
| workspace.google.com/signup | Workspace 注册（不同流程） |

---

## 二、可执行方案优先级（更新后）

### 🟢 Tier 1: 立即执行

1. **多 context 并行 (A3)** — 已验证 3 context 可行，预期 3x 提速
2. **登录页 MI613e API 化** — 响应差异明确，可以用 XHR 直接调用
3. **自适应速率控制** — 纯代码优化
4. **Session 池化** — 纯代码优化

### 🟡 Tier 2: 值得投入

5. **登录页 + 注册页交替** — 两个独立限速池
6. **Cookie 导出 + 独立 HTTP** — CDP 可获取完整 cookies
7. **Identity Toolkit (自有 Key)** — 需要 10 分钟创建 Firebase 项目

### 🔴 Tier 3: 不推荐

- 所有 Google 域名变体（全部重定向到同一后端）
- 所有需要 OAuth 的 API（People, Drive, Calendar, Chat）
- Gravatar（命中率 0%）
- Google+ / Profiles（已关闭）
- SMTP（已验证不可靠）

---

## 三、关键风险

1. **IP 限制**: 第 5 个登录测试时连接被断开，说明 Google 有 IP 级频率限制
2. **reCAPTCHA**: 000001@gmail.com 触发了验证码
3. **假阴性**: test@gmail.com 在登录页显示"找不到"（可能是保护机制）
4. **Session 降级**: 注册 API 的 [null,[]] 问题仍然存在
