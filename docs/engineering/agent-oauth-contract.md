# OAuth 第一步：认证库、发现与同意契约

本页说明默认关闭的第一步协议组合。后续[第二步有限receiver绑定](agent-oauth-receiver.md)已实现独立主体映射、scope交集、MCP challenge及逐次/订阅撤权的内部契约；仍未给现有listener启用OAuth，没有真实账号连接、部署、持久订阅或模型调用。完整真实联调闸门仍见[联调手册](agent-real-integration.md)。

## 依赖与实现选择

- 锁定 `better-auth`、`@better-auth/mcp`、`@better-auth/oauth-provider` 为 `1.7.6`；直接使用原已锁定的 `zod@4.6.5`。官方 npm 元数据的 peer 范围匹配本仓库版本，没有全仓升级。
- 组合是 `jwt()` + `mcp()`。后者内部就是 OAuth provider，不能再同时挂第二个 `oauthProvider()`。密码、签名、授权码、PKCE、JWT、资源关系与 OAuth consent 存储均由官方库实现。
- 暂选一个预先配置的 public client（`none` + authorization code/S256），精确 HTTPS redirect，不启用 DCR、CIMD、client credentials、OIDC profile/email、DPoP 或 refresh。
- 官方[OpenAI认证指南](https://developers.openai.com/plugins/build/auth)列出 CIMD、DCR、predefined OAuth client 三种方式；`none` 是 public-client token 方法。实际 dot 的插件管理入口、精确 redirect、client 配置能力与资格仍须在获准的用户实例核对，本片不能证明已经兼容或安装成功。不能凭文档猜生产 callback。
- 若真实入口最终需要 CIMD/DCR，另做受限实现；CIMD 的 metadata/JWKS 传输必须有 HTTPS、SSRF、地址钉定、体积和超时边界。当前没有动态客户端取件，也没有借由配置 URL 发起网络访问。

官方依据：[MCP组合](https://better-auth.com/docs/plugins/mcp)、[OAuth provider](https://better-auth.com/docs/plugins/oauth-provider)、[1.7迁移](https://better-auth.com/docs/guides/1-7-upgrade-guide)。文档与锁定包差异以实际 1.7.6 导出/API及fixture为准。

## 关闭状态与隔离

[createIdentity](../../packages/identity/src/index.ts)新增可选内部 `oauth` 配置；省略时返回 `oauth: null`，不会迁移 OAuth/JWKS/interaction 表，也不会注册客户端。既有 `localIdentityOptions`、主应用、remote listener、CLI和环境变量都没有开启该配置的入口。没有启动新 listener，现有本机/远端路由总闸不变。

程序化 opt-in 使用同一个 identity SQLite 中已有的 user/account，复用既有密码/受邀开户记录；不复制用户，不用 email/display name 充当新的 subject 映射。issuer 固定为配置 HTTPS origin + `/collaboration-auth`，resource 固定为同 origin `/collaboration/mcp`。后续公开部署仍需专用 TLS、人机登录/同意页面及新的部署安全评审，不能把本机 handler 暴露出去。

OAuth cookie 使用独立 `__Secure-hexu-oauth` 命名、路径 `/collaboration-auth`、Secure/HttpOnly/SameSite=Lax。签名 secret 由原 identity secret 与 issuer 的固定 context 派生，避免仅改 cookie 名即可移植本机会话。原 team-local secret/cookie/会话流程不变。新登录仅窄 JSON 登录契约，返回 `{ok:true}` 与 HttpOnly cookie，不把 library session token/user 记录返给页面；浏览器表单/UI尚未交付。

## 迁移与静态注册

仅显式 opt-in 时用 `getMigrations(auth.options)` 的真实库迁移，并在调用者的 SQLite `BEGIN IMMEDIATE` 中加入 `hexu_oauth_interactions`。失败回滚并关闭当前 identity handle；成功后才返回可用契约。只允许在获准的实例使用；本次仅临时测试库，没有迁移活动库。

插件 schema 包含 oauthClient、oauthResource、oauthClientResource、oauthConsent、oauthAccessToken、oauthRefreshToken、oauthClientAssertion、jwks；schema 含 refresh 表不等于允许 refresh grant。OAuth 限速用同库 `rateLimit`，不借测试关闭限速。资源首次由库按配置惰性播种。

客户端不是自动创建。内部 `provisionConfiguredClient(headers)` 要求现有 issuer session，并经官方 server-only `adminCreateOAuthClient` API保存唯一配置的 public client；仅该内部调用上下文具有创建权限，不暴露 HTTP注册/管理路径，不生成 client secret。重复调用比对原记录；redirect、scope、grant、PKCE、skipConsent等不匹配即拒绝，不覆盖旧配置。对实际实例执行该方法仍是客户端注册/权限配置动作，须单独获准。

## Request/Response allowlist

`oauth.handler(Request)` 是待集成的内部契约，固定 origin/host、不接受 Forwarded/x-forwarded，正文上限16KiB、URL上限12KiB。无业务数据路由、无公开 signup/setup/invite、无原始整个 Better Auth handler。

- GET `/.well-known/oauth-authorization-server/collaboration-auth`，及 `/collaboration-auth/.well-known/oauth-authorization-server` 别名
- GET `/.well-known/oauth-protected-resource`，及其 `/collaboration/mcp` 后缀别名
- GET `/collaboration-auth/jwks`
- GET/POST `/collaboration-auth/sign-in`：已有账户登录契约；没有 HTML界面
- GET `/collaboration-auth/oauth2/authorize`
- GET/POST `/collaboration-auth/consent`：经验证的同意视图与明确决定
- POST `/collaboration-auth/oauth2/token`：只收 form-urlencoded，public client，不接受Cookie/Origin/Authorization头

同意/登录写入必须同源JSON；内部 provider consent 与 context 验证端点不能从allowlist直接调用。错误仅保留允许的 OAuth error code，响应 no-store/no-referrer，不能把token、code、signed query、cookie或内部错误正文写日志。

1.7.6 discovery 对纯静态 public client漏报 `none`，因此在窄wrapper中准确归一化为 `['none']`，不为修metadata而开启DCR。元数据删除未开放的 introspection、revoke、userinfo、backchannel logout和DPoP宣告。实际端点、issuer、resource与S256由fixture核对。

## 同意和令牌边界

authorize 必须有唯一准确 client、redirect、resource、state、code/S256、43字符challenge；scope必须含 `hexu:material_read`，可附 `hexu:respond`。不接受未知scope、重复关键参数、request_uri/JAR/OIDC claims。每次授权强制明确consent，即使库里已有旧同意。

官方文档示例的 `verifyOAuthQueryParams` 在1.7.6包中并未公开导出。本片用窄自定义插件端点，让 provider 原before-hook验证完整signed query后，通过公开 `getOAuthProviderState()`读取已验证状态，并用官方session middleware取身份；没有复制库HMAC验证器。

GET consent返回真实client名称、精确callback/resource、请求scope、短期consentId与 `businessAccess: not_bound`。interaction以规范化完整signed query摘要为键，绑定当前session ID与user ID，nonce只存hash。POST仅接受同一query/session/nonce与scope子集，原子认领一次，随后通过真正的Request转发provider consent。不同session、篡改、到期、重排后的重放均拒绝。认领后的失败/未知保持已消费，须重新authorize；不会悄悄重试发码。记录保留到signed query到期，避免短期nonce过期后把同一query重新开放。

库负责code的单次消费和PKCE验证；错verifier会消费该code。token请求若带resource必须精确相同，省略则沿用原code的resource绑定；JWT期限300秒，授权码120秒。JWT subject来自既有Better Auth user，client/audience/issuer/scope由库填写。JWT签名/issuer/audience/到期用注入本地JWKS的官方验证器测试，没有外部网络请求。

## 有限业务接入与未完成范围

仅配置第一步、不注入 `receiverDatabase` 时，返回的JWT不是 `AgentReceiverPrincipal`，`resourceServer:null`；已有token仍无法读父Task/Project、收件或材料。第二步显式 opt-in 会要求同意时选择一个既有receiver/revision，保存原完整principal，并独立检查scope交集，细节见[有限接入](agent-oauth-receiver.md)。

1.7.6 JWT access token的 `/oauth2/revoke` 返回 unsupported_token_type；只删OAuth consent或撤refresh也不能使已发JWT立即失效。标准revoke/refresh继续不开放、不宣告。第二步用当前binding代次与原receiver授权每次重验，并提供隔离session下的业务binding撤销，不把库JWT撤销误写成已支持。

实际HTTPS部署、浏览器登录/同意、真实dot/Codex、第二成员、跨环境、既有桌面聊天接回均尚未验收。第一步历史检查见[本片记录](../development/history/2026-10-08-agent-oauth-contract.md)，第二步当前检查见[后续记录](../development/history/2026-10-08-agent-oauth-receiver.md)。
