# 身份、权限与数据可见性 harness

> 按需读取：修改账号、空间/项目角色、会话、授权、SSE 或幂等回放的访问规则。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[03 工作包](../development/03-identity-projects.md)；使用：[team-local](../engineering/team-local.md)。
- 代码：[身份服务](../../packages/identity/src)、[权限](../../packages/db/src/permissions.ts)、[成员事务](../../packages/db/src/collaboration.ts)、[HTTP 身份边界](../../apps/control/src/identity.ts)。

## 真实身份与 preview 隔离

The default preview remains single-user and fictional. Optional team-local uses Better Auth 1.7.6, real users and explicit project roles, but stays loopback-only. It never initializes host native resources or accepts mock/native execution dispatch. Only the separate owner-authorized node provider may dispatch work; native/mock control-host dispatch remains forbidden. Preserve separate preview/business/auth databases; do not relabel or seed preview data as team data.

Use request-scoped principals and PermissionService for direct objects, lists, search, SSE and idempotent replays. Space ownership is not access to another person's private task or every project. Check permissions before returning stored idempotent results. Revalidate session and membership during event delivery; clear old UI data on revocation or identity changes. Keep session tokens out of browser storage/JSON, secrets out of logs, and invitation tokens hash-only at rest. Do not expose the full authentication handler or unrestricted signup. Email verification, password recovery and production/remote security remain incomplete; see team-local.md.

## 如何验证与回写

复用 [真实账号夹具](../../tests/helpers/team.ts) 与 [团队浏览器流程](../../tests/e2e/team.spec.ts)。检查直接 ID、列表/搜索、事件与旧回执；至少覆盖本次受影响的撤权或降权路径，不能只验证隐藏按钮。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

项目归档/改派/参与见 [项目任务](projects-tasks.md)；有限快照授权见 [协助](assistance.md)；节点 Cookie/Bearer 边界见 [节点](nodes.md)。

## 有限远端协作边界

独立 `remote-collaboration` TLS listener 只开放有限 requester/receiver/MCP2 协作面，不开放原Web登录、human API、节点或原生控制。preview/team-local host/origin边界继续不变；不以反向代理或隧道替代此入口。当前bearer作用域不是OAuth实现，真实插件认证另验。凭据、订阅与每次投递均重新验证当前身份/期限；receiver bootstrap只派生请求专属权限。详见[使用与部署边界](../engineering/agent-remote-events.md)。
