# OAuth 窄路由与登录/同意接线

2026-10-08。本片将前两步内部契约组合到原独立 TLS 协作服务，默认关闭；没有实际部署、注册客户端、迁移活动身份库或安装插件。前置与真实验收仍按[联调手册](agent-real-integration.md)。原[token/receiver契约](agent-oauth-receiver.md)的逐次撤权与scope交集不变。

## 显式配置与数据归属

`createRemoteCollaboration` 的可选 `oauth` 接收已有 identity SQLite 绝对路径、原 identity secret 和单个 public client metadata。它以独立 handle 打开已有身份库；拒绝不存在/空身份库、非私有文件及与 business 同一文件，不初始化账号、邀请或其他业务身份。OAuth resourceServer 固定使用 `store.db`，直接注入同一个 AgentEvents；原本机 identity handle、secret派生隔离与 preview/team-local 边界保留。

原 `remote-main.js` 只有显式 `HEXU_COLLABORATION_OAUTH_ENABLED=1` 才读取以下配置。省略或0保持原路由与身份初始化行为；其他flag报错，不偷偷开启：

- `HEXU_COLLABORATION_IDENTITY_DATABASE`：原团队 identity.sqlite 的绝对路径，私有文件，已有受邀账号。
- `HEXU_COLLABORATION_IDENTITY_SECRET_FILE`：原 identity secret 的已有绝对文件路径，私有regular file，上限4096字节。不生成新secret，不读setup-code；若原实例使用环境覆盖，部署者须另行获准提供同一secret的私有文件。
- `HEXU_COLLABORATION_OAUTH_CLIENT`：JSON对象，仅 `id`、`name`、`redirectUris`；确切值来自另行获准的真实客户端配置，不能猜callback。

原 TLS、origin、business数据库和event key配置仍必需。独立单实例服务直接终止TLS，不信任代理头；源码不包含生产配置示例值或真实凭据。源码版需一并保留 `packages/ui/src/tokens.css`；缺失时启动失败，不复制另一套配色。

配置metadata不等于注册。启动仅迁移显式选择的身份库OAuth schema，绝不自动调用 `provisionConfiguredClient`。该server-only方法继续要求现有issuer session且须另行批准；没有公开注册/管理接口、DCR/CIMD或client secret。未预置客户端时authorize失败关闭。本次只在可丢弃fixture里注册虚构public client。

## 路由和 Request/Response 边界

同一TLS listener精确列举OAuth discovery/JWKS、authorize、sign-in、consent、token、本人binding读取/撤销以及两份只读CSS。未知路径、注册、密码重置、原Better Auth raw handler、human API、节点/原生控制仍不开放。

- Host、规范请求目标、Forwarded/x-forwarded检查是共同总闸。
- MCP/requester/receiver及非浏览器OAuth端点仍拒绝query、Cookie、Origin、Sec-Fetch-Site；MCP使用JWT资源认证，不能用浏览器session代替。
- 仅OAuth浏览器allowlist可携带路径限定session和authorize签名query。所有浏览器POST要求精确同源Origin且拒绝cross-site和Authorization；JSON合同保留，只有sign-in/consent另接受原生form-urlencoded。
- Fastify独立封装的raw buffer parser保留表单原始字节，16KiB/5秒总正文期限，未完成正文不进入issuer数据库队列。返回完整status、Location及独立Set-Cookie值；不记录正文、授权码、签名query、token、cookie或库错误。
- 页面no-store/no-referrer/nosniff，CSP禁止脚本/嵌入/base，仅允许同源CSS、同源form和已锁定精确callback（用于提交后的303回跳）。没有CORS、第三方字体、CDN或浏览器存储。

## 最小实际页面

浏览器Accept HTML取得原生中文页面；原JSON调用兼容保留。登录页只接受官方provider验证过的签名query；提交同样重验签名和期限。凭据只交原Better Auth，成功写隔离Secure/HttpOnly/SameSite=Lax cookie，303回本issuer的原authorize参数。没有客户端returnTo或任意重定向，登录不批准业务访问。

同意页显示当前账号、client、精确callback/resource、请求scope、现有receiver完整关联/修订及期限。必须手选一个仍有效receiver；material_read必需，respond默认不勾选且始终受原scope交集约束。无可选连接时禁用批准，拒绝仍可提交。页面复用唯一W1 tokens、原生标签/fieldset/focus、窄屏换行、44px操作目标和无脚本浅色选择，不构造另一管理台。

原签名query/session/user/nonce一次性认领不变。重复提交、旧页Back/刷新后过期或撤权均拒绝；已消费或未知结果需从原客户端重新authorize，不自动再次发码。拒绝通过原provider返回原callback的access_denied。页面关闭不提交；表单不持久化密码。真实浏览器的视觉、键盘、Back/Forward与CSP实施尚未验收，HTTP/HTML fixture不能替代这些证据。

## 300秒限制与最小后续刷新定义

access token最长300秒，当前OAuth Events订阅不超过该JWT或receiver期限。没有refresh grant或offline_access，也没有长期无人值守保证。真实往返若超过5分钟，需要重新明确授权；新同意产生新binding，不能暗中延长旧订阅或自动重跑模型。本片不扩大refresh。

安全刷新至少需要另行明确：

1. 真实客户端支持与用户批准的持续权限、绝对有效期和撤销入口；不因刷新扩大原receiver/scope/项目/材料/版本。
2. 官方provider的旋转refresh token、单次消费/重用检测和族撤销；存储保护、并发刷新、丢失响应及重启语义，不能在不确定时造新业务身份。
3. refresh固定原issuer/subject/client/resource/binding及连接代次，刷新前后重验成员/receiver/grant/capability/期限；撤销或重入永不复活旧族。
4. 明确定义事件订阅更新时机和身份：原订阅不凭旧token续命，新访问令牌不得静默拓宽订阅或重放工作；每次发送保持当前权限复验。
5. 先用可丢弃库覆盖并发、重放、撤权、到期和未知结果，再经获准的真实客户端/浏览器联调。标准JWT revoke与HEXU binding撤销继续分开表述。

这些仅是后续契约，未实现或启用。实际HTTPS/证书/部署、客户端注册、插件安装、持续订阅、用户本机与已有Codex聊天、第二真实成员/材料及模型预算仍待确定和批准。
