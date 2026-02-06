# Identity Toolkit 研究结果

## 结论：不可行

Google 在 Identity Toolkit 所有端点都做了防枚举保护，无法区分 Gmail 邮箱是否存在。

## 测试结果

| 端点 | 存在的邮箱 | 不存在的邮箱 | 能区分？ |
|------|-----------|------------|---------|
| createAuthUri | registered=false | registered=false | ❌ 只查 Firebase 项目内用户 |
| signInWithPassword | INVALID_LOGIN_CREDENTIALS | INVALID_LOGIN_CREDENTIALS | ❌ 故意不区分 |
| sendOobCode | 200 OK | 200 OK | ❌ 都返回成功 |
| signUp | 200 (创建新用户) | 200 (创建新用户) | ❌ 在自己项目里创建 |

## 速率数据（仅供参考）

- 10 并发: 15.4 req/s
- 50 并发: 54.9 req/s  
- 100 并发: 触发 QUOTA_EXCEEDED
- 速度很快但没用，因为无法检测 Gmail 邮箱

## 最终结论

注册页 NHJMOd API 仍然是唯一可行的方案。
