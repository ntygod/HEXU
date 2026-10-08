# OAuth第一步：认证库组合与discovery/consent契约

日期：2026-10-08。基线 `8ace878cf3a9072a2e829a7833fd04e64a4a1c61`（tree `75771800f0a1038db4b283eb91f2f60a2912a47a`）；独立分支 `codex/oauth-discovery-consent-contract`。保留前序片1—7准备实现、文档和验证记录，不更改main/workflows，不创建PR。

## 已实现

- 官方匹配 `better-auth/@better-auth/mcp/@better-auth/oauth-provider@1.7.6`；新增两认证包，直接声明原有zod4.6.5，不变更已有依赖版本。
- 默认关闭的程序化 `IdentityOptions.oauth`；使用同一原identity SQLite user/account记录，插件表在opt-in时事务迁移，独立issuer派生签名secret/cookie，原loopback/signup保护不变。
- 单个受控预配置public client，只授权码/S256；内部显式注册经官方API，HTTP无DCR/CIMD/signup/管理面。实际dot实例配置方式、资格和redirect仍未核对。
- 准确discovery/JWKS、精确resource/redirect/client、scope allowlist与PKCE verifier长度/字符约束；签名同意query由真实provider验证，nonce只存hash，绑定精确session/user且原子单次认领，失败不重试发行。
- 没有listener/CLI/env开关，没有有限receiver主体、业务授权、refresh/revoke、MCP challenge或订阅撤权。后续边界详见[工程说明](../../engineering/agent-oauth-contract.md)。

## 实际检查

最终执行结果在交付时核对：

- 原完整server/Web TypeScript检查：通过。
- 原 `npm run build:server`：通过，包含静态build-restore-helper编译；未执行restore助手行为。
- 新模块 `node --test dist/tests/oauth-issuer.test.js`：14项通过。
- 原Web production build：通过；仅保留已有bundle体积提示。
- 改动文件Prettier、`git diff --check`、文档相对链接及原102项ID/状态保持：通过。

fixture只用独立临时SQLite、虚构成员和临时签名材料。全局fetch注入拒绝，未触发任何网络请求。验证覆盖：默认关闭和本机限制、从旧identity库升级/重复迁移、同用户原本机会话保留、discovery公开字段、路由allowlist、真实library登录无JSON token、cookie重命名仍隔离、单client精确redirect/resource、S256及弱verifier拒绝、真实code/同意/JWT签名与issuer/audience/期限、错误PKCE/code重放/并发消费、同意session混用/篡改/重排重放/拒绝/减scope、到期、存储client漂移拒绝、code兑换前session撤销。没有使用旧state-auth拒绝比较诊断。

未运行全 `npm test`、`npm run check`、CI或浏览器；没有旧state-auth迟到401/403诊断、#52 selected-file apply/restore、实际restore行为、模型、真实OAuth注册或用户接入。

## 独立冷审及修正

独立审查指出两项P2，均已修正并新增/重跑对应测试；最终只读复审确认无剩余P1/P2：

1. 同意query摘要默认Array.sort对含逗号的不同key/value可能比较相等，重排可产生另一摘要。改用明确key-then-value比较，并分别限制unsigned/signed参数名；拒绝未知逗号参数组合，合法signed参数重排仍定位同一已消费interaction。
2. 官方1.7.6 token API只把verifier作为string并比较哈希，未约束RFC7636长度/字符。wrapper补43–128位unreserved字符验证；fixture含challenge确实匹配1字符弱verifier的拒绝，而非只测哈希错误。

初轮自检还修正了302响应被错误清洗丢失Location、provider consent直接server API缺少Request对象、deny不应传空scope，以及隔离库的持久限速存储。实际包没有导出文档中的verifyOAuthQueryParams，因此改用其公开provider-state+hook组合。以上失败与修正不作为通过证据；最终结果仅对应最终源码。

本片不提高原工作项完成状态，不等同真实dot/Codex、跨成员/跨环境闭环或原桌面聊天继续。
