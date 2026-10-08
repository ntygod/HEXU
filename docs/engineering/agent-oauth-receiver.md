# OAuth 第二步：有限 receiver 绑定与撤权

这是默认关闭的内部接入契约，接续[认证库与同意契约](agent-oauth-contract.md)。原 `createApp` 不开启；后续[接线](agent-oauth-wiring.md)为 `createRemoteCollaboration`/CLI增加明确opt-in，默认关闭，没有实际公网部署。真实部署、client 配置、浏览器登录/同意、插件安装与持久订阅仍需[联调手册](agent-real-integration.md)的授权与环境。

## 明确选择既有有限授权

程序化 `IdentityOptions.oauth.receiverDatabase` 必须显式指向原 team business SQLite。该handle不来自请求或客户端输入；remote组合由服务端注入同一business handle，省略时保持第一步仅发行无业务绑定令牌的模式，`resourceServer:null`。绑定模式使用独立 identity SQLite handle，原本机身份 handle 不会加入 OAuth consent 事务；同一用户记录与 user ID 复用，不以 email、display name 或模型提供的 subject 映射身份。

GET consent 返回当前已认证用户所有、仍有效的 receiver 选择，含连接 ID/revision、participant/project、能力/grant 版本、期限与 scopes。POST consent 在原签名 query、session 与单次 nonce 之外，明确提交 `receiver:{connectionId,connectionRevision}`。只可选择一个已经由本人批准的有限 receiver；重新验证当前 owner、space/project membership、endpoint、capability、delegation grant/revision、期限。不会创建 grant、participant、Task、Run 或另一枚 receiver Bearer。

interaction 单次认领先持久保存；之后官方 provider consent、完整 receiver 快照、批准的 OAuth scopes、随机 binding ID 和 code 哈希映射在同一 identity SQLite 事务提交。失败全部回滚，interaction 仍保持已消费，必须重新 authorize。business 授权在建绑定和提交前都重新检查；两库不是分布式事务，后续每次使用仍核当前 business 事实。issuer 的 DB/provider 操作串行化，但请求体在队列外读取，16KiB/5秒总截止，未完成请求不能占住认证/撤权队列。

兑换仍由官方库负责 code 单次使用、S256 与 JWT 签名。wrapper 用 code 哈希定位原绑定，并经官方 `customAccessTokenClaims` 加入随机 `hexu_binding`；不把 receiver/project/material ID、快照或 token 写入 URL/日志。每次重新明确同意产生独立代次，旧 token 永远不能重解释为另一连接或新代次。尚无 refresh，不把重新同意称作 token refresh。

## 验证、scope 交集与原业务事务

`oauth.resourceServer.authenticate` 用官方 `verifyJwsAccessToken` 和本地官方 JWKS 校验 EdDSA、`at+jwt`、issuer、精确 audience、exp/nbf/iat、最长300秒、client 与 binding。没有任意 JWKS URL 或网络取件。1.7.6 官方验证器会用 azp 归一化 client_id；wrapper 在签名通过后另核原始签名中的两项一致且匹配配置，拒绝矛盾声明。

binding 固定 `(issuer,subject,client,resource)`、receiver 完整快照和到期。每次使用调用原 `revalidateAgentReceiverConnection`，按原完整 principal 比较；从不覆写 `actor.scopes`。独立 `require` 计算 OAuth token scope、该次同意 scope 与 receiver scope 的交集；任何一层缺 respond 均不能回应。

MCP 复用原 `AgentReceiverStore` 与 `AgentAssistanceStore`。读/list/material 先验 OAuth，再走原请求专属材料授权。回应在进入、原事务内及旧回执返回前重验 OAuth 与原接收授权，不能凭旧幂等键绕过撤权。没有父 Task/Project 通用读取能力；原 receiver Bearer 的默认本机路径保持独立，不将 JWT 交给旧 Bearer 解析器。

## MCP 资源与 challenge

只有明确将 `resourceServer` 注入 `AgentEvents` 并调用 `attachAgentMcpHttp` 的内部组合才提供 OAuth MCP 适配；独立remote启动函数已提供默认关闭的显式注入；原本机启动不变。资源 adapter 必须与 Events 使用同一 business handle。测试只用 Fastify inject，无真实监听。

- 公开必要信息：protected-resource metadata、`server/discover` 和 `tools/list`，不含用户业务数据。各工具声明 `securitySchemes` 与必要 scope。
- 其余调用均需认证。失效 token或缺少必需material_read返回 HTTP401 `WWW-Authenticate`；认证成功后缺业务/OAuth respond scope返回403；工具错误还带 `_meta["mcp/www_authenticate"]`，不回显 token、库错误或内部身份。
- 固定 resource host/path，拒绝 query、Cookie/Origin、身份覆盖、Forwarded/x-forwarded 与 DPoP。未知端点不转发到原应用。
- 官方依据：[OpenAI插件认证](https://developers.openai.com/plugins/build/auth)。真实客户端对这些 metadata/challenge 的消费尚未联调，不能据 fixture 声称安装可用。

## 撤销与订阅

已登录的隔离 issuer session 可 GET `/collaboration-auth/receiver-bindings` 查看自己的绑定元数据，POST `/collaboration-auth/receiver-binding/revoke`，正文仅 `{bindingId}`，同源JSON要求与原consent相同。撤销是幂等、永久的该代次业务授权撤销；别人的session不能撤销，旧JWT不能复活它。该窄JSON管理契约仅在remote OAuth显式opt-in时挂载；没有另造管理台。

这是 HEXU binding 撤销，并非官方 JWT `/oauth2/revoke`。标准 revoke/refresh 端点仍不开放、不在 discovery 宣告；本片不把删除 OAuth consent、短 TTL 或库的 unsupported_token_type 响应当作即时撤权。

迁移42只为原订阅增加 nullable `oauth_authority`。OAuth订阅保存服务端验证过的 issuer/binding/scopes/token期限，不保存JWT；订阅identity还包括binding代次，不能与原Bearer订阅或新同意混用。TTL不超过 receiver 及 JWT 到期；未实现refresh，因此不能声称无人干预的长期OAuth订阅。

订阅候选验证前、最终提交前、每次事件处理及实际网络发送前，都核当前 binding、client、receiver、成员、能力/grant版本与请求材料权限。OAuth撤销或原连接撤销后，旧订阅不再发送；重启未配置原OAuth验证器也失败关闭，不降级为Bearer。已有outbox条目在drain时记 suppressed，原Assistance历史与有权父Task用户访问不变。进行中的网络请求/已经交付的文本无法追回，不推断外部模型已停止。

## 验证和剩余

可丢弃虚构成员、临时 identity/business SQLite、临时签名材料与注入发送；新OAuth测试禁止网络fetch，未用真实OAuth配置。范围及最终检查见[实现记录](../development/history/2026-10-08-agent-oauth-receiver.md)。登录/同意HTML及服务适配已有后续接线；真实HTTPS目标、账户client/redirect、浏览器验收、插件权限、第二真实成员、模型费用、用户本机与原聊天继续均未启用或验收。原被拒浏览器与受限诊断/恢复范围不变。
