# ADR-0005｜真实账号与本机执行分离

日期：2026-09-26（UTC+8）。对应 HX-DEV-03 与 01-04 的本机切片。

## 决策

选择锁定 Better Auth 1.7.6，经 IdentityPort 处理密码、Cookie 会话和撤销；使用该版本支持的 node:sqlite 与程序化迁移。HEXU 不另造 JWT 签名或密码哈希方案。不直接挂载全量认证路由，仅开放明确的登录/退出/初始化/受邀加入/改密/撤销入口；注册还在组件钩子中检查受控上下文。

业务权限属于 HEXU：空间成员与项目 view/edit/manage 分离，私有任务仅所有者可读。PermissionService 同时用于查询与写入；请求主体通过 AsyncLocalStorage 绑定而不是修改全局 actor。已撤权用户不能通过旧幂等响应读取结果；SSE 每次发送前重查会话和授权。

认证文件和团队业务文件独立于旧预览数据。团队模式没有默认示例用户，也不会把“林舟”等虚构记录自动授予第一个注册者。预览模式仍可独立运行已有本机 Agent；真实账号模式禁止继承宿主机能力，等待独立节点授权。

## 限制

当前只支持回环地址、单服务进程与 SQLite。没有 SMTP 验证、忘记密码恢复、SSO、通用 AccessGrant、PostgreSQL 或生产安全审计。跨认证/业务库注册失败不做不可靠的跨库回滚；再次核验邀请以防未授权加入，保留明确恢复路径。

## 采用时核对的上游资料

- Better Auth SQLite： https://www.better-auth.com/docs/adapters/sqlite
- Email / Password： https://www.better-auth.com/docs/authentication/email-password
- Fastify 集成： https://www.better-auth.com/docs/integrations/fastify
- 会话： https://www.better-auth.com/docs/concepts/session-management
- 安全与 Cookie： https://www.better-auth.com/docs/reference/security

接口使用锁定发行包的类型和实际用例核对，不以网页说明替代运行结果。依赖版本不是长期兼容或无漏洞承诺。
