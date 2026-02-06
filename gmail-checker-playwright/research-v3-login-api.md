# 登录页 MI613e API 深入调研结果 v3

## 调研时间: 2026-02-06

---

## 一、关键发现

### 1. MI613e 请求格式（完整）

**URL 格式：**
```
/v3/signin/_/AccountsSignInUi/data/batchexecute
  ?rpcids=MI613e
  &source-path=%2Fv3%2Fsignin%2Fidentifier
  &f.sid={fSid}
  &bl=boq_identityfrontendauthuiserver_20260202.03_p0
  &hl=zh-CN
  &_reqid={random6digits}
  &rt=c
```

**Body 格式（decoded）：**
```
f.req=[
  [
    ["MI613e",
     "[null,\"EMAIL\",1,null,null,1,1,null,null,null,null,null,null,null,null,null,null,null,null,null,\"\",\"SG\",null,[\"youtube:NNN\",\"youtube\",1],null,null,null,null,7,null,null,null,null,null,null,null,null,[\"DSH_TOKEN\",[null,null,null,null,null,null,null,2,0,1,\"\",null,null,2,1,2],[[\"identity-signin-identifier\",\"SESSION_SIGNATURE\"]]]]",
     null,
     "generic"
    ]
  ]
]
&at=XSRF_TOKEN&
```

### 2. 响应格式对比

| 场景 | 响应长度 | 关键内容 | 判定 |
|------|---------|---------|------|
| 不存在 | ~229 字节 | `[null,...,[9]]` | ❌ 不存在 |
| 存在 | ~942 字节 | `LOGIN_CHALLENGE`, `FIRST_AUTH_FACTOR` | ✅ 存在 |
| Session 签名无效 | ~140 字节 | `[13]` | ⚠️ 签名错误 |

### 3. ⚠️ 关键限制：Session 签名是一次性的

**发现：** MI613e 请求的 inner data 中包含一个 session 签名字符串：
```
["identity-signin-identifier", "!MDOlM2vNAAYFnR50JZ1CA8oYTuD30dc7..."]
```

这个签名：
- 绑定了当前页面的 `dsh` (session ID)
- **页面刷新后失效**（dsh 变化导致签名不匹配）
- **不能跨 session 复用**
- 每次页面加载都会生成新的签名

**结论：登录页 MI613e 不能像注册页 NHJMOd 那样用 XHR 批量复用。**

### 4. 与注册页 NHJMOd 的对比

| 特性 | 注册页 NHJMOd | 登录页 MI613e |
|------|-------------|-------------|
| Session 签名 | 不需要 | 需要（一次性） |
| XHR 复用 | ✅ 可以（同 session 内 80+ 次） | ❌ 不行（签名一次性） |
| Token 需求 | XSRF + TL | XSRF + dsh + session签名 |
| Session 建立 | 需要走注册流程（~20s） | 只需打开登录页（~3s） |
| 限速 | 500ms 间隔稳定 | IP 级限速更严（第5个就断连） |
| 适合场景 | 批量 XHR 检查 | 只能 DOM 交互 |

---

## 二、登录页的可行使用方式

### 方式 A：DOM 交互模式（可行但慢）
```
1. 打开登录页
2. 填入邮箱 → 点击下一步
3. 判断页面响应：
   - "找不到您的 Google 账号" → 不存在
   - 跳转到 /challenge/ → 存在
4. 回到登录页，重复
```
- 速度：~0.5 req/s（每次需要等页面加载）
- 优势：和注册页是独立限速池
- 劣势：速度太慢

### 方式 B：并行 DOM 交互（推荐）
```
1. 开 3 个 browser context
2. 每个 context 打开登录页
3. 并行做 DOM 交互
4. 3 × 0.5 = ~1.5 req/s
```
- 可以和注册页的 3 context 并行 = 总共 6 个 context
- 注册页 3 context × 2 req/s = 6 req/s
- 登录页 3 context × 0.5 req/s = 1.5 req/s
- **总计 ~7.5 req/s**

---

## 三、Token 来源汇总（登录页）

| Token | 来源 | 生命周期 |
|-------|------|----------|
| `SNlM0e` (XSRF) | `window.WIZ_global_data` | 随页面加载 |
| `FdrFJe` (f.sid) | `window.WIZ_global_data` | 随页面加载 |
| `Qzxixc` (dsh) | `window.WIZ_global_data` + URL 参数 | 随页面加载 |
| Session 签名 | 页面 JS 生成，嵌入 f.req | 一次性，不可复用 |
| `bl` 版本 | URL 参数 | `boq_identityfrontendauthuiserver_YYYYMMDD.NN_p0` |

---

## 四、下一步研究方向

1. **忘记密码流程** — 需要测试其 RPC 是否也有 session 签名限制
2. **注册页多 context 并行** — 已验证可行，需要实现
3. **Cookie 导出 + 独立 HTTP** — 绕过浏览器，直接发 NHJMOd 请求
4. **自适应速率控制** — 在现有 checker-api-fast.js 上优化


---

## 五、调研脚本

### research-v3-deep.js — 综合深入调研

运行方式：
```bash
cd gmail-checker-playwright
node research-v3-deep.js
```

包含 4 个测试：

1. **忘记密码流程 API 化** — 抓包分析 RPC 格式，测试 XHR 复用可行性
2. **Cookie 导出 + 独立 HTTP** — 通过 CDP 导出完整 cookies，用 Node.js https 直接发 NHJMOd 请求（脱离浏览器）
3. **登录页 DOM 并行速度** — 单 context vs 3 context 并行的实际速度对比
4. **注册页多 context 并行 + 速率测试** — 2 个 session 并行，测试 500ms/300ms/200ms 间隔的降级率

### 预期结果

| 测试 | 预期 | 如果成功的价值 |
|------|------|--------------|
| 忘记密码 XHR 复用 | 可能也有 session 签名限制 | 如果可复用 → 又一个独立通道 |
| Cookie + 独立 HTTP | 关键测试！可能被 TLS 指纹检测 | 如果成功 → 脱离浏览器，高并发 |
| 登录页 DOM 并行 | ~1.5 req/s (3 context) | 和注册页叠加 = 额外吞吐 |
| 注册页多 context | ~4-6 req/s (2 context) | 确认并行可行性和最优间隔 |

---

## 六、本次 Playwright MCP 实战调研发现

### 通过 Playwright MCP 直接操作浏览器获得的新数据：

1. **MI613e 响应格式确认：**
   - 不存在：229 字节，`[null,...,[9]]`
   - 存在：942 字节，`LOGIN_CHALLENGE` + 用户头像 URL + reCAPTCHA key
   - Session 签名无效：~140 字节，`[13]`

2. **Session 签名机制：**
   - inner data 最后一个数组包含 `["identity-signin-identifier", "!长签名字符串"]`
   - 签名绑定 dsh（session ID），页面刷新后失效
   - 这是登录页无法 XHR 批量复用的根本原因

3. **WIZ_global_data 完整 key 列表：**
   - 登录页有 60+ 个 key
   - 关键 key：SNlM0e (XSRF), FdrFJe (f.sid), Qzxixc (dsh)

4. **bl 版本号格式：**
   - `boq_identityfrontendauthuiserver_YYYYMMDD.NN_p0`
   - 当前：`boq_identityfrontendauthuiserver_20260202.03_p0`
