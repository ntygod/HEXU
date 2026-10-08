# 有限远端协作与 MCP Events

本入口复用原 Task/Assistance/固定材料及回执；没有第二套任务、模型运行或协商完成状态。当前代码可用范围及实测边界见[片5记录](../development/history/2026-10-08-agent-remote-events.md)。真实 dot 插件、OAuth/账号连接、第二真实成员、跨设备及模型继续尚未验收。

## 两种独立协议面

- 本机 Codex：既有经典 stdio MCP `2025-11-25`。发起者显式设置 `HEXU_TRANSPORT=remote`、`HEXU_CONTROL_URL=https://明确的服务地址` 后，经有限 requester API；仍须原 owner-issued `hexu_requester_` 凭据及原 thread/session 配置。默认仍只准回环 HTTP。经典 receiver 仅保留本机单请求预置兼容方式，不接受 remote 模式。
- dot：独立 `/collaboration/mcp`，MCP2 `2026-07-28`。每次独立认证，不要求旧 initialize；支持 server/discover、tools/list/call 与 events/list/subscribe/unsubscribe。请求需现代 MCP-Protocol-Version、Mcp-Method、工具调用 Mcp-Name 及 params._meta 的协议版本/clientCapabilities。
- 实现了有限 bearer 协议面，没有实现 OAuth 授权服务器或证明某真实 ChatGPT 账号接受该认证配置。正式接入必须核对插件支持的认证配置；不能把本机合成 bearer 证明当成真实安装成功。

官方依据：[Events](https://developers.openai.com/plugins/build/mcp-events)、[MCP server](https://developers.openai.com/plugins/build/mcp-server)、[现代 HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。

## 接收授权与新请求 bootstrap

有权所有者在已登录的原本机管理入口，使用 POST `/api/v1/agent-participants/:participantId/receiver-connections` 明确发行连接：projectId、capabilityId/version、endpointRevision、grantId/revision、scopes（material_read，可加 respond）、expiresAt、receiveConfirmed=true。最长24小时且不能超过现有 delegation grant。GET 同资源/`:connectionId` 查看元数据；POST `/:connectionId/revoke` 带 expectedRevision 撤销。各写入需要原 Idempotency-Key 与浏览器会话/来源约束。

首次发行只返回一次 `hexu_receiver_` token；同键重试只返回元数据与 null token。服务只保存哈希。实际安装真实 token 是持续权限配置，必须得到所有者相应授权；不要粘贴到任务正文、通知、URL或日志。

连接固定当前 grant 与版本，之后新请求通过此连接取件，不需要人逐条搬运 request token。每次请求派生仅该 Assistance 的有限主体，事务内再核对当前成员、grant、endpoint、capability、材料与输入授权。没有父 Task/Project 读取权，不借用 owner 的人工身份。旧 capability_read 与单请求 token 不扩大权限。

原有限接收 REST 为 `/agent-receiver/v1/identity`、`/requests`、`/requests/:requestId`、`/requests/:requestId/input-revisions/:revision` 及 POST `…/responses`，需 x-hexu-agent-api:1。MCP2提供 hexu_list_requests、hexu_get_request、hexu_read_materials、hexu_respond；调用复用同一存储方法。

## 订阅与投递

事件 `hexu.assistance.changed`，arguments 为 `{}`，只覆盖该连接授权内的请求。payload 仅 `{requestId}`；无文本、parent IDs、凭据或控制指令。订阅后先调用 list_requests 同步现有收件；协议无历史 replay/cursor。断线后同样读当前请求，不根据通知顺序推断业务进度。

订阅身份固定 authenticated connection + callback URL + event name + canonical arguments；有限 TTL 不超过连接到期。ChatGPT 在用户批准的订阅动作中提供 callback URL 与 whsec signing secret，HEXU不自行生成真实平台订阅。首次及缓存过期后使用单次短时签名challenge验证；refresh在验证完成前保留旧有效订阅，unsubscribe可阻止正在验证的候选提交。轮换有5分钟双签名窗，同键refresh不丢失旧key。

Callback只接受 HTTPS/443、无userinfo/fragment、公共地址。每次投递解析所有DNS地址，拒绝任何非公网地址，连接pin到已校验IP并保持证书hostname；不跟随redirect，DNS+传输总10秒、响应16KiB上限。IPv6采用保守公网范围，部分特殊地址即使实际可路由也会被拒绝。

URL和签名材料使用外部32字节key AES-256-GCM加密入库；AAD绑定订阅ID，日志不记录payload/URL/key。原outbox insert同事务生成每subscription/sequence唯一投递。每次发前核当前授权；重复/乱序由原request修订及业务幂等处理。2xx仅记callback已收，不记Agent已接受、已使用、Run成功或Task完成。

未知收件/进程退出保留原eventId，重试生成新时间签名，指数退避最多6次。410/413及其他非暂时4xx/3xx不重试。取消/撤权/到期抑制后续投递；已发出的网络请求无法撤回。不得据unknown重建付费模型工作。数据库中 delivery 的 pending/inflight/accepted/unknown/failed/suppressed 只表示传输观测。

## 独立 TLS 服务配置（不等于已部署）

`preview`/`team-local` 主入口和loopback规则完全保留。额外入口只公开有限协作API，没有Web管理、注册、原生/节点控制或任意转发。使用现有已配置的 team 数据库；不把preview数据库转换为团队库，不自动开户或开放登录。

运行 `node dist/apps/control/src/remote-main.js` 需要：

- HEXU_COLLABORATION_DATABASE：已有team SQLite库绝对路径
- HEXU_COLLABORATION_ORIGIN：客户端实际访问的HTTPS origin（含必要端口）
- HEXU_COLLABORATION_HOST：默认127.0.0.1；实际外网bind由获授权部署者设置
- HEXU_COLLABORATION_PORT：默认8443，1024–65535
- HEXU_TLS_CERT_FILE / HEXU_TLS_KEY_FILE：服务证书与0600私钥文件
- HEXU_EVENT_KEY_FILE：0600文件，恰好32原始字节；需独立备份并限制访问

服务直接终止TLS，固定Host，不信任/接受forwarded headers，没有通用反向代理部署模式。服务进程与数据目录按最小OS权限运行；单实例，不运行两台投递协调器，不允许两个进程同时派发同一outbox。节点app-server端口留在个人设备内部。没有自动续期、OAuth、托管运营或Kubernetes能力声明。

## 备份、恢复与诊断

`node scripts/backup-collaboration.mjs SOURCE NEW_BACKUP` 用SQLite在线backup产生一致新副本（0600），拒绝覆盖；事件加密key另外安全备份。备份包括有限凭据哈希、订阅和业务回执，不能上传到公共仓库。丢失key不能解密或投递旧订阅，不能以重建订阅伪装恢复。

恢复时先停止旧服务，保留原库/WAL与现场；在独立目录恢复新副本及匹配key，再配置新实例，不覆盖活动业务库。核对原requestId、回执、订阅和未确认投递；启动只恢复unknown事件，不启动模型。fixture覆盖关闭重开与独立备份副本，未演练真实生产灾难恢复。

有界诊断看服务端数据库的投递state/attempts/last_status，及客户端当前request读取。不要输出 private_body、callback URL、token_hash、请求原文或key。6次失败后需要管理者查配置并让已授权客户端重新查询收件；没有自动“任务成功”补偿。过期连接需要所有者重新明确授权。

## 首次真实联调仍需

一个获准长期在线HTTPS测试服务/证书与持久目录；两个真实成员的可丢弃项目和有限知识；本机Codex与dot实际版本/插件资格；双方明确连接、订阅和能力/费用权限。2026-10-08核对的官方ChatGPT插件路径不支持用户自供静态API token，认证MCP使用OAuth；现有有限Bearer不能直接当作dot插件接入。最小OAuth桥接设计、实际原线程证据和逐步停止条件见[真实联调准备](agent-real-integration.md)。只有这些条件齐备后，才能验证真实求助→澄清→返回→原工作继续。当前无真实部署、真实插件订阅或模型费用调用。
