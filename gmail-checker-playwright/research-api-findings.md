# Gmail 用户名检查 API 深入调研结果

## 1. 最小必需参数

通过逐一去除参数测试，确定了真正必需的参数：

### Headers（全部可选！）
| Header | 去掉后 | 结论 |
|--------|--------|------|
| `X-Same-Domain: 1` | 200 ✅ | 可选 |
| `x-goog-ext-278367001-jspb` (flowName) | 200 ✅ | 可选 |
| `x-goog-ext-391502476-jspb` (dsh) | 200 ✅ | 可选 |
| `Content-Type` | 200 ✅ | 必需（否则 body 解析失败）|
| 全部只留 Content-Type | 200 ✅ | **只需要 Content-Type** |

### URL 参数
| 参数 | 去掉后 | 结论 |
|------|--------|------|
| `TL` | 401 ❌ | **必需** - 这是 transaction token |
| `f.sid` | 200 ✅ | 可选 |
| `bl` | 200 ✅ | 可选 |
| `source-path` | 200 ✅ | 可选 |
| `_reqid` | 200 ✅ | 可选 |
| `hl` | 200 ✅ | 可选 |

### Body 参数
| 参数 | 结论 |
|------|------|
| `f.req` | **必需** - 包含 NHJMOd RPC 调用 |
| `at` (XSRF token) | **必需** - 在 body 中传递 |

### 最小可用请求
```javascript
// URL: /lifecycle/_/AccountLifecyclePlatformSignupUi/data/batchexecute?rpcids=NHJMOd&TL={tlToken}
// Headers: Content-Type: application/x-www-form-urlencoded;charset=utf-8
// Body: f.req=[encoded_rpc_data]&at=[xsrf_token]&
```

## 2. 响应格式完整分类

| 响应 JSON | 含义 | 判定 |
|-----------|------|------|
| `[[["steps/signup/password"]]]` | 跳转到密码页 | ✅ 可用 |
| `[null,[]]` | 空响应 | ⚠️ 可能可用，也可能 session 降级 |
| `[null,[["建议1","建议2"]]]` | 有替代建议 | ❌ 已被占用 |
| `[null,[["建议"]],["该用户名已被占用"]]` | 明确占用 | ❌ 已被占用 |
| `[null,null,["长度必须介于6到30"]]` | 长度错误 | ❌ 无效 |
| `[null,null,["不允许使用该用户名"]]` | 保留名 | ❌ 不允许 |
| `null` (parsed[0][2] 为 null) | 简化格式错误 | ❌ 请求格式错误 |

### 关键发现：`[null,[]]` 的二义性
- 新 session 下，`[null,[]]` 极少出现（第1轮的 testuser 偶尔返回）
- session 降级后，所有用户名都返回 `[null,[]]`
- **判定规则**：如果探针用户名（已知可用）返回 `[null,[]]` 而非 `[[["steps/signup/password"]]]`，说明 session 已降级

## 3. Session 降级机制

### 发现
- 新 session 前 30 个请求（10 轮 × 3）全部准确
- 大量请求后（约 50+ 次），session 进入"降级"状态
- 降级后所有用户名返回 `[null,[]]`，不再做真正的检查
- 降级不是突然的，可能是渐进的

### 探针检测策略
```javascript
// 探针：用一个已知可用的随机长用户名
const probe = await checkUsername('dhjfkjshfk234hjkdhkh');
if (probe.inner === '[null,[]]') {
  // Session 已降级，需要刷新
  refreshSession();
}
// 正常应该返回 [[["steps/signup/password"]]]
```

## 4. 并发能力

| 模式 | 5个请求耗时 | 吞吐量 |
|------|------------|--------|
| 并发 5 | 780ms | ~6.4 req/s |
| 串行 5 | 2135ms | ~2.3 req/s |
| 并发 10 | 792ms | ~12.6 req/s |
| 串行 20 | 10890ms | ~1.8 req/s |

- 并发 10 个请求全部 HTTP 200，无频率限制
- 并发加速比约 2.7x
- 但并发时部分响应可能返回 `[null,[]]`（不确定是并发导致还是 session 问题）

## 5. 批量请求（batchexecute 多个 RPC）
- 尝试在一次 batchexecute 中包含多个 NHJMOd 调用 → 返回 400
- **结论：不支持同一 RPC 的批量调用**，每次只能查一个用户名

## 6. 频率限制
- 30 个串行请求（无延迟）：无限制
- 10 个并发请求：无限制
- 之前旧 session 发了 50+ 个请求后降级
- **建议**：每个 session 控制在 30-40 个请求内，然后刷新

## 7. 优化后的 checker-api-fast.js 策略

```
1. 获取新 session（走注册流程到用户名页面）
2. 提取 xsrf + TL token
3. 探针验证（确认返回 [[["steps/signup/password"]]]）
4. 串行发送请求（每个间隔 150ms）
5. 每 30 个请求做一次探针检查
6. 如果探针返回 [null,[]]，立即刷新 session
7. 每个 session 最多用 40 个请求
```

## 8. Token 来源汇总

| Token | 来源 | 生命周期 |
|-------|------|----------|
| `SNlM0e` (XSRF) | `window.WIZ_global_data` | 随 session |
| `FdrFJe` (f.sid) | `window.WIZ_global_data` | 随 session |
| `TL` | URL 参数 | 随注册流程 |
| `Qzxixc` (dsh) | `window.WIZ_global_data` | 随 session |
| Cookies | 浏览器自动管理 | httpOnly，不可读 |

## 9. 降级机制深入分析（第二轮调研）

### 关键发现：降级是速率相关的，不是总量限制

| 实验 | 请求间隔 | 总请求数 | 首次降级 | 连续降级 | 结论 |
|------|---------|---------|---------|---------|------|
| 无延迟串行 | ~0ms | 40 | 第6个 | 频繁 | 快速降级 |
| 500ms 延迟 | 500ms | 80 | 第12个 | 最多1次 | 偶尔闪降，自动恢复 |

### 降级行为特征
1. **不是硬性计数限制** — 不是"第N个请求后一定降级"
2. **速率敏感** — 请求越快，降级越频繁
3. **可自动恢复** — 降级后等一会儿，下一个请求可能恢复正常
4. **`[null,[]]` 是临时状态** — 不代表 session 永久失效
5. **500ms 间隔足够安全** — 80 个请求只偶尔闪降

### 修正后的最优策略
```
旧策略：每 30 个请求刷新 session（浪费时间）
新策略：
1. 请求间隔 500ms（关键！）
2. 遇到 [null,[]] 时不立即刷新 session
3. 改为重试当前用户名（等 1-2 秒）
4. 连续 3 次 [null,[]] 才刷新 session
5. 单个 session 可以用 80+ 个请求
```

### 吞吐量对比
| 策略 | 有效吞吐量 | 说明 |
|------|-----------|------|
| 无延迟 + 频繁刷新 session | ~0.5 req/s | 刷新 session 需要 15-20s |
| 500ms 延迟 + 长 session | ~2 req/s | 稳定，几乎不需要刷新 |
| 300ms 延迟（推荐测试） | ~3 req/s | 待验证 |

## 10. 优化后的最终策略

```
1. 获取 session（走注册流程到用户名页面）
2. 提取 xsrf + TL token
3. 探针验证
4. 串行发送请求，间隔 500ms
5. 遇到 [null,[]] → 等 2s 重试，不刷新 session
6. 连续 3 次 [null,[]] → 刷新 session
7. 每 50 个请求做一次探针（不是 30 个）
8. 单个 session 目标：80-100 个请求
```
