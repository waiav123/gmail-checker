# 深入研究 v4：提速优化 + API 方案 + 数据源优化

## 调研时间: 2026-02-06

---

## 一、提速优化：为什么 3 context 只有 2.3/s 而不是 10/s

### 根因分析

当前配置：3 context × 300ms 间隔 = 理论 10 req/s
实际速度：2.3/s = **仅 23% 效率**

**核心问题：降级是 IP 级别的，不是 context 级别的。**

从 log 分析：
- 大量 `降级 #1` 出现（几乎每 2-3 个请求就有一次降级）
- 降级退避 1500ms-7500ms 消耗了大量时间
- 3 个 worker 同时请求 = 同一 IP 瞬时 10 req/s → 触发 Google 的 IP 级限速

### 关键数据对比

| 配置 | 理论速度 | 实际速度 | 效率 | 降级频率 |
|------|---------|---------|------|---------|
| v3 研究：2 ctx × 200ms | 10/s | 4.3/s | 43% | 零降级（仅 10 个请求） |
| 当前：3 ctx × 300ms | 10/s | 2.3/s | 23% | 极高（每 2-3 个请求） |
| 单 ctx × 500ms | 2/s | ~2/s | ~100% | 极低 |

**v3 研究的 4.3/s 是短期测试（仅 10 个请求），长期运行降级会累积。**

### 最优单 IP 配置推算

Google 的 IP 级限速阈值大约在 **3-4 req/s**：
- 低于 3/s：几乎零降级
- 3-5/s：偶尔降级，可自动恢复
- 5+/s：频繁降级，大量时间浪费在退避

**推荐配置：**

| 方案 | 配置 | 预期实际速度 | 说明 |
|------|------|------------|------|
| A: 保守稳定 | 2 ctx × 400ms | ~3.5/s | 几乎零降级 |
| B: 平衡 | 2 ctx × 300ms | ~4.0/s | 偶尔降级 |
| C: 激进 | 3 ctx × 350ms | ~4.5/s | 有降级但可控 |

**关键洞察：增加 context 数量在单 IP 下收益递减，因为瓶颈是 IP 级限速。**

### 优化方案 1：全局速率协调器

当前问题：3 个 worker 各自独立计时，可能同时发请求。
解决：加一个全局令牌桶，确保总请求速率不超过阈值。

```javascript
// 全局速率限制器
class RateLimiter {
  constructor(maxPerSecond) {
    this.minInterval = 1000 / maxPerSecond;
    this.lastRequest = 0;
  }
  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await new Promise(r => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequest = Date.now();
  }
}
// 用法：所有 worker 共享一个 limiter
const globalLimiter = new RateLimiter(4); // 全局 4 req/s
```

### 优化方案 2：自适应速率控制

根据降级频率动态调整请求间隔：

```javascript
class AdaptiveRateController {
  constructor() {
    this.baseDelay = 250;
    this.currentDelay = 250;
    this.degradeWindow = []; // 最近 N 秒的降级次数
  }
  
  onDegrade() {
    this.degradeWindow.push(Date.now());
    // 最近 10 秒降级超过 3 次 → 减速
    const recent = this.degradeWindow.filter(t => Date.now() - t < 10000);
    if (recent.length > 3) {
      this.currentDelay = Math.min(this.currentDelay * 1.5, 1000);
    }
  }
  
  onSuccess() {
    // 逐步恢复速度
    this.currentDelay = Math.max(this.currentDelay * 0.95, this.baseDelay);
  }
}
```

---

## 二、其他 API 方案分析

### 已验证的方案总结

| 方案 | 可行性 | 速度 | 限制 |
|------|--------|------|------|
| 注册页 NHJMOd (当前) | ✅ | 2-4/s | IP 级限速 + 降级 |
| 登录页 MI613e | ❌ XHR不可复用 | 0.5/s DOM | Session 签名一次性 |
| 忘记密码 MI613e | ❌ | 同上 | Session 签名一次性 |
| Identity Toolkit | ❌ 无自有 Key | - | 需要 Firebase 项目 |
| Cookie + Node.js | ❌ | - | TLS 指纹被检测 |
| SMTP 退信 | ❌ | - | 不可靠 |

### 值得尝试的新方向

#### 方向 1：Identity Toolkit（自有 Firebase Key）

这是最有潜力的替代方案。Google Identity Toolkit 有一个 `createAuthUri` 端点：

```
POST https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=YOUR_API_KEY
Body: {"identifier":"test@gmail.com","continueUri":"http://localhost"}
```

- 如果邮箱存在：返回 `registered: true`
- 如果不存在：返回 `registered: false`

**优势：**
- 纯 HTTP API，不需要浏览器
- 可以高并发（不受浏览器 context 限制）
- 独立的限速池

**需要：**
- 创建一个 Firebase 项目（免费）
- 获取 API Key
- 测试限速阈值

**风险：**
- Google 可能对免费 Key 有严格限速
- 可能需要多个 Firebase 项目轮换 Key

#### 方向 2：注册页 + 登录页交替

虽然登录页 DOM 模式慢（0.5/s），但它和注册页是**独立的限速池**。

组合方案：
- 注册页 2 context × API 模式 = ~4/s
- 登录页 2 context × DOM 模式 = ~1/s
- **总计 ~5/s**

比纯注册页 3 context 的 2.3/s 更快，因为分散了 IP 压力。

#### 方向 3：curl-impersonate

用 curl-impersonate 模拟 Chrome 的 TLS 指纹，直接发 HTTP 请求：

```bash
curl_chrome120 -X POST \
  'https://accounts.google.com/lifecycle/_/AccountLifecyclePlatformSignupUi/data/batchexecute?rpcids=NHJMOd&TL=...' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'f.req=...&at=...'
```

**优势：** 脱离浏览器，可以高并发
**风险：** 需要正确的 Cookie 和 TLS 指纹

---

## 三、数据源优化

### 当前问题

数据源：6 位纯数字 (000000-999999)
结果：**100% taken**（7270 个全部 taken，0 个 available）

Gmail 从 2004 年开始运营，22 年来所有 6 位数字用户名早已被注册。

### 更有可能找到可用用户名的策略

#### 策略 1：7-8 位数字

```python
# 7 位数字：0000000-9999999 = 1000 万个
# 8 位数字：00000000-99999999 = 1 亿个
# 越长越可能有空位
```

但纯数字仍然热门，7 位可能也大部分被占。

#### 策略 2：字母+数字混合（更有价值）

```python
# 有意义的短用户名更有价值
# 例如：名字缩写 + 数字
patterns = [
    "a{3digits}",      # a000-a999 = 26000 个
    "{2letters}{4digits}",  # aa0000-zz9999 = 676万个
    "{word}{2digits}",  # 常见词+数字
]
```

#### 策略 3：特定格式的稀缺用户名

```python
# 最有价值的格式：
# 1. 纯字母短用户名（6位）：aaaaaa-zzzzzz
#    总量：26^6 = 3.08 亿，但常见词已被占
# 2. 有意义的词组：firstlast, word+number
# 3. 品牌/关键词相关
```

#### 策略 4：随机生成 + 智能过滤

```python
import random, string

def generate_likely_available():
    """生成更可能可用的用户名"""
    patterns = []
    
    # 模式 1：随机 8 位字母数字（最可能可用）
    for _ in range(100000):
        s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        patterns.append(s)
    
    # 模式 2：辅音组合 + 数字（不像真名，更可能可用）
    consonants = 'bcdfghjklmnpqrstvwxyz'
    for _ in range(100000):
        s = ''.join(random.choices(consonants, k=4)) + ''.join(random.choices(string.digits, k=4))
        patterns.append(s)
    
    # 模式 3：长数字（10+ 位）
    for _ in range(100000):
        s = ''.join(random.choices(string.digits, k=random.randint(10, 15)))
        patterns.append(s)
    
    return patterns
```

### 推荐数据源优先级

| 优先级 | 数据源 | 数量 | 预期可用率 | 说明 |
|--------|--------|------|-----------|------|
| 1 | 随机 8 位字母数字 | 10 万 | 5-20% | 最可能有空位 |
| 2 | 10+ 位纯数字 | 10 万 | 10-30% | 长数字不太热门 |
| 3 | 辅音+数字组合 | 10 万 | 10-30% | 不像真名 |
| 4 | 7 位纯数字 | 100 万 | 1-5% | 比 6 位好一些 |
| 5 | 6 位纯数字 (当前) | 100 万 | ~0% | 全部被占 |

---

## 四、综合执行计划

### Phase 1：立即优化（30 分钟）

1. **全局速率协调器** — 限制总请求速率在 4/s
2. **自适应速率控制** — 根据降级频率动态调速
3. **减少 context 到 2 个** — 单 IP 下 2 context 比 3 context 更高效

预期效果：从 2.3/s → 3.5-4.0/s

### Phase 2：数据源优化（15 分钟）

1. 生成新的测试数据集（随机 8 位字母数字）
2. 先跑 1000 个测试，验证可用率
3. 如果可用率 > 5%，切换到新数据源

### Phase 3：Identity Toolkit 探索（30 分钟）

1. 创建 Firebase 项目获取 API Key
2. 测试 createAuthUri 端点
3. 测试限速阈值
4. 如果可行，实现纯 HTTP 版本的 checker

### Phase 4：多方案并行（如果 Phase 3 成功）

- 注册页 API：2 context × ~4/s = 4/s
- Identity Toolkit：纯 HTTP × ?/s
- 总计可能达到 10+/s
