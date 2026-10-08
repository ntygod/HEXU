# OAuth接线：独立TLS、窄桥与原生登录/同意

日期：2026-10-08。基线 `1e03b5faf292655185dadb21608662f4e8a9b43f` / tree `64eea14f13227a9b5917a40d3f2f1f47fd3285ec`；独立候选 `codex/oauth-remote-wiring`。保留前两步全部验证记录；不PR、不改main/workflows、不部署、不升级依赖。

## 本片实现

- 原独立TLS协作listener显式default-off组合；复用原已存在identity文件/secret、单独identity handle及相同business handle。空/缺失/不私有或混用business文件拒绝。启动不注册client、不初始化身份或grant。
- 精确OAuthallowlist与独立raw-body Request/Response桥，保留status、Location和分离Set-Cookie。正文16KiB/5秒总截止；慢正文不占issuer队列。共同Host/规范目标/代理头检查与旧MCP/requester/receiver的query/Cookie/Origin拒绝保持。密码入口另按真实TLS peer IP限制每分钟10次。
- 无JavaScript的原生中文登录/同意页，复用唯一W1 tokens、语义表单、焦点/窄屏规则和原生浅色选项。官方provider hook核signed query后登录，只回同issuer原authorize。显示当前账号、client/callback/resource及现有receiver，显式scope/连接选择，拒绝与错误不暗中续流程。
- 单次consent、原receiver权限/scope交集、逐次工具/事务/回执/投递撤权不变；300秒token/订阅上限未扩大。无refresh/长时间无人值守保证，最小刷新后续契约只记文档。
- `remote-main` shutdown先await app.close，再关闭owner business store，避免Fastify LIFO后加store钩子先关库。OAuth handle随服务完成请求/投递后关闭。

## 实际作者验证

Node24.19.0，原锁文件依赖，所有成员/密码/客户端/签名和数据库均为临时虚构fixture。

- 新接线12项：`oauth-remote` 9项 + `remote-oauth-config` 3项，通过。
- 原OAuth38项及相关回归54项通过；最终显式列举13个测试文件，合计104/104，无全仓test/check/CI。
- 原 `npm run build:server` 通过，包含完整server配置及静态helper编译，没有执行任何restore行为。
- 原 `npm run typecheck` server/Web配置通过；原Vite构建186模块通过，保留已有500kB非阻断bundle提示。
- `npm run check:ui`、7个修改TypeScript文件Prettier、`git diff --check`通过。

最终定向命令（先构建server）为：

```sh
node --test dist/tests/oauth-issuer.test.js dist/tests/oauth-receiver.test.js dist/tests/oauth-remote.test.js dist/tests/remote-oauth-config.test.js dist/tests/agent-remote.test.js dist/tests/agent-receiver-http.test.js dist/tests/agent-events-http.test.js dist/tests/agent-events-process.test.js dist/tests/event-webhook.test.js dist/tests/agent-mcp-protocol.test.js dist/tests/agent-assistance-http.test.js dist/tests/agent-assistance-store.test.js dist/tests/task-agent-collaborations.test.js
```

真实Node loopback HTTPS测试仅使用一次性自签名fixture信任根（验证证书/SNI，未关闭TLS验证），逐步执行authorize→signed登录GET→原生formPOST→隔离cookie→原authorize→HTMLconsent→批准/拒绝callback→原始form PKCE→有限MCP。另测慢chunked正文实际5秒408且独立metadata/MCP不阻塞；此为HTTP协议fixture，不是实际浏览器。

负例包含未配置client不自动注册、同库subject/receiver映射、无receiver禁批准、expired receiver提交失败、重复form/nonce409、wrongPKCE401/code再用400、缺流程/坏签名/returnTo、raw/signup/helper路由拒绝、Host/proxy/CSRF/oversize、peer限速、旧MCP边界和HTML转义。Set-Cookie保留数组且每项Secure/HttpOnly/Lax/path隔离；资源、scope、receiver撤权继续由原38项覆盖。

初次新测试误把wrongPKCE预期写400；锁定provider与旧测试已有契约为401，现按真实契约修正并补同code正确verifier重放400。初版TypeScript测试形状错误及bridge错误状态被统一成400的问题均在最终构建前修复；未放松权限或测试边界。

## 独立审查

此前未参与本片实现的独立审查者只读核对生产差异、窄路由/签名流程、原MCP边界、表单与CSP、期限/关闭处理及新负例，另行运行 `oauth-remote` + `remote-oauth-config`，12/12通过；独立核对页面CSS变量全部来自canonical tokens。未发现可证实P1/P2。审查指出联调文档一处旧“未开启服务入口”表述易与新接线混淆，已改为明确“已有默认关闭接线，但真实实例未启用”。没有把这项审查或HTTPfixture写成实际浏览器验收。

## 验收限制

真实浏览器未运行：不重试既有Chromium socketEPERM或CUA ERR_BLOCKED_BY_CLIENT路线，不使用别名/隧道/代理绕行。HTML结构/HTTP跳转不能证明浏览器视觉、键盘、Back/Forward、原生校验或CSP实施；这些仍须获准浏览器验收。

无真实HTTPS目标/证书/部署、OAuth客户端注册、插件安装/持续授权订阅、用户本机原Codex聊天、第二真实成员/材料或模型费用调用。没有活动库/真实凭据配置；只有临时fixture签名与loopback监听。未运行全npm test/check/CI、旧state-auth迟到401/403诊断、#52 selected-file故障注入或恢复助手。代码可接线不等于真实dot成功或首个跨成员里程碑。

当前操作与后续安全刷新定义见[接线说明](../../engineering/agent-oauth-wiring.md)，实际部署/注册与联调批准仍按[联调闸门](../../engineering/agent-real-integration.md)。
