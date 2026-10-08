# OAuth第二步：有限receiver绑定、challenge与撤权

日期：2026-10-08。精确基线 `192c1e6a9a0103452289c83d86b12274020a77df`，tree `3d87f72342a898a3b65303c9d5feae20d1077720`；独立分支 `codex/oauth-receiver-binding`。不创建PR、不改main/workflows，不新增依赖或真实部署。

## 已实现

- session绑定、单次consent明确选择已有receiver/revision；从可信user ID建立 `(issuer,subject,client,resource)` 与原完整有限principal/同意scope/期限的随机binding代次。别人的连接和任意body身份拒绝，不新发receiver凭据或grant。
- 独立identity handle，官方consent、binding和授权码哈希映射同SQLite事务；失败回滚且原interaction保持消费。请求体在串行队列外有16KiB/5秒界限。
- 官方库负责code/PKCE/JWT，受控custom claim携带binding ID。资源验证官方签名/JWKS、issuer、单resource、typ、client、iat/nbf/exp和scope；原始签名azp/client_id一致性另验。
- 原principal保持不变，OAuth token/该次同意/receiver scope独立相交；原MCP读取与业务回应复用既有有限领域方法，回应事务及旧回执前都重验。
- 显式注入时的公开必要metadata、工具OAuth securitySchemes、HTTP401/403及工具级challenge。既有listener没有注入或新开关，默认旧Bearer协议不变。
- 自定义隔离session业务binding撤销；事件订阅保存验证上下文、TTL不超过JWT、identity含binding代次，投递前及真实sender授权回调重验当前授权。重启缺验证器失败关闭；原库标准revoke和refresh仍不开放。

当前使用、数据边界与未实现事项见[工程说明](../../engineering/agent-oauth-receiver.md)。

## 实际检查

- OAuth定向38项：第一步14项 + 第二步24项，通过。使用真实Better Auth原API、临时identity/business SQLite、虚构账号、临时签名材料、Fastify inject及注入发送；新OAuth组全局fetch明确拒绝，未触发网络。
- 相关回归51项：`agent-receiver-http`、`agent-events-http`、`agent-events-process`、`event-webhook`、`agent-mcp-protocol`、`agent-assistance-http`、`agent-assistance-store`、`task-agent-collaborations`。保留原Node loopback/独立stdio协议fixture，不启动模型。
- 原完整server/Web TypeScript检查、原 `build:server` 含静态恢复helper编译、原Web production build：通过。静态helper仅编译，未执行恢复行为；Web保留已有bundle体积提示。
- Prettier、`git diff --check`、文档相对链接、原102项行内容/状态保持：通过。原工作项未提高完成状态。

新增覆盖：默认关闭与公开metadata/匿名拒绝；当前本人选择与revision；半条consent/binding/code失败回滚及单次消费；OAuth与receiver两方向scope交集；有限材料无父信息；旧回执和事务内撤销；真实签名的错误issuer/audience/subject/client/binding、过期/未来时间/缺scope/篡改；新同意不重定向旧token；成员删除重入、项目重入/降级、能力/端点/grant/连接版本、连接期限、client停用；订阅验证中撤销、发送前撤销、重启缺验证器、JWT到期停止、未结束body不堵认证及总截止。

## 审查与修正

首轮自检发现官方1.7.6 `verifyJwsAccessToken` 会用azp覆盖返回的client_id；改为签名通过后核原始签名两项与配置一致。另修正测试fixture的旧SPA fallback断言、项目角色值和回放投递的到期时间，未放宽生产权限或原测试。

独立冷审指出一个P2：初版把整个请求体读取放进issuer共享串行队列，未结束的匿名POST会阻塞后续认证和撤销。现已移到队列外，增加总读取截止与不阻塞取消，新增持有stream时认证/撤销仍完成和fake-timer截止测试。冷审还建议补JWT实际到期后的投递覆盖，已完成。最终独立只读复审已确认修正关闭，无剩余可证实P1/P2；审查者未重复运行测试，执行结果以上述实际日志为准。

未运行全 `npm test/check/CI`、浏览器、旧state-auth迟到401/403诊断、#52 selected-file故障注入或实际restore行为。未注册真实OAuth client、安装插件、建立实际持久订阅、迁移活动库、公开listener、接用户本机、调用模型或借第二真实成员/材料。fixture不能作为真实跨成员/远端/原桌面聊天继续证据；HTTPS目标和相应权限仍待确认。
