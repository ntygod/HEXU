# 2026-10-08｜有限远端协作与 Events

## 基线与交付边界

独立 `codex/agent-remote-events`，基线为片4远端 `bb1c6be94718708579cba572e71018024b94eb04`。保留原规划与片1—4实现，不修改main、旧feature或workflow，不创建PR，不操作用户电脑或其他项目。

- receiver预先发行独立有限连接，绑定一项grant/endpoint/capability及版本，最长24小时。新请求自动派生请求专属主体，不逐条搬token；旧capability_read及原单请求凭据不扩权。撤权/到期与事务内当前权限先于历史回执，重加入不复活。
- 独立MCP2 HTTP `2026-07-28`，与经典stdio分离。Events与工具同认证端点，工具回原Assistance读取/澄清/回答。请求元数据/header一致性检查，不信客户端自报owner。
- 订阅identity与canonical参数确定，同key刷新；异步verification intent防并发/取消竞态；刷新不停止旧有效订阅。callback/签名secret加密保存，轮换双签名、同secret重试保留轮换窗。
- 原outbox trigger在原业务事务中生成唯一ID-only投递；每次发送复核当前权利，签名保留原eventId、更新timestamp，unknown不重复创建业务或付费运行。2xx仅传输accepted。HTTPS公共地址校验及DNS pinning、无redirect、总超时与尺寸上限。
- 单独直接TLS的有限collaboration listener；原preview/team-local不开放公网。显式remote经典requester可用；receiver使用MCP2 bootstrap。没有OAuth授权服务器、远程Web账号管理或原生控制端口。
- 新一致SQLite备份命令和独立副本恢复测试，不覆盖活动数据库，不恢复模型执行。事件加密key需另行保管。

## 实际检查

- 原完整 `npm run build:server` 通过（TypeScript与仅静态cc helper编译），不执行恢复助手。
- 27项新增本地检查：4 receiver真实BetterAuth/SQLite、8 MCP2/Events真实HTTP与可丢弃callback集成、12签名/安全单测、3远端配置/TLS/备份。签名网络投递fixture使用注入的本机HTTP callback；生产sender仍拒绝私有地址，没有绕过公网规则。
- 107项相关后端回归通过；完整原server/Web类型、UI tokens、Vite181模块通过，保留既有非阻断大bundle提示。
- 新增1项完整独立进程链通过：一次receiver连接与订阅→经典stdio requester创建固定原thread绑定→原outbox签名通知→独立callback进程经实际HTTP MCP2读材料/澄清/回答→原requester消费/ACK。首个callback响应丢失及两次同ID重复，不增加Assistance或消费；断言1Task/1Assistance/0Run/0逐请求token。实际脚本见[整链测试](../../../tests/agent-events-process.test.ts)与[接收进程](../../../tests/fixtures/agent-event-receiver.ts)。
- 旧双stdio协议与原thread结果回接5项独立进程回归通过；仍是fixture，不是实际原生模型。
- 独立安全review的订阅刷新漏事件、轮换重试丢旧key、错误remote receiver配置已修复；复查无未决P1/P2。

安装阶段新的npm ci未留下可用依赖，保持锁文件不变，核对与片4锁文件相同后复制该已验证工作副本的node_modules进行检查；没有升级依赖或运行安装脚本。测试初始list结构断言、TypeScript类型和旧刷新状态期望已修正并重新执行，不隐藏失败。完整check/CI、旧Provider跨身份与#52恢复链诊断、浏览器均未运行。

## 验收矩阵

| 范围 | 实际证据/限制 |
| --- | --- |
| 新请求自动取得有限权限 | 预置一次receiver连接后创建请求，read/response无单请求token；仅固定共享材料，不泄露parent IDs |
| 当前权限/过期/撤权 | 事务内插入撤权再重放旧response拒绝，owner降权/移除后重新加入仍失效；事件过期/取消/撤权后无callback |
| 协议隔离 | MCP2不走initialize；元数据/header不匹配拒绝；旧capability/requester/Cookie不能冒充receiver |
| 实际TLS | 本机独立HTTPS listener与证书校验客户端完成原有限API；Host/forwarded/browser/human/native路径拒绝；不是外网部署 |
| 完整双进程旅程 | requester与receiver独立OS进程，一次bootstrap后无人工问答/token搬运；同thread消费及ACK为host-reported/确定性fixture，非真实模型 |
| callback签名/重放 | 独立HTTP receiver收取精确签名字节；合成接收验签/过期timestamp与重复ID检查；SSRF地址/URL单测，生产公网DNS/TLS未外连 |
| 事务/未知/重启 | 原业务/outbox同事务回滚；丢响应仍相同eventId；关闭并重开app/Store保留subscription和unknown投递；不生成Run |
| refresh/轮换 | 挂起refresh期间继续投递，错误challenge不停止旧订阅；A→B再refresh B仍双签名 |
| 一致备份 | 在线SQLite backup至新副本，保留回执/有限credential哈希且0Run，拒绝覆盖已有文件；不是生产灾备演练 |

## 未验事项与下一项

真实本机Codex、当前dot插件/认证/订阅、第二真实成员、跨设备通信、真实模型使用回答继续与浏览器均未验。当前静态bearer不能作为真实ChatGPT OAuth接通证明；需要先确认支持的插件认证或补OAuth。实际部署、持续权限、订阅签名材料和模型费用尚未启用。原thread引用仍host_reported，fixture后续输出不是真实native继续证明。

片5为本地可验证协议/恢复子集，完整25片5及片7实际里程碑未完成。唯一下一代码切片为6 Task内体验收口，真实片5环境验证作为前置残余保留。最小真实接入清单见[工程说明](../../engineering/agent-remote-events.md)。

发布仅独立feature，既有workflow只main push/all PR；本分支无PR不触发整仓CI，不能用旧CI替代本轮测试。最终发布需核对远端head/parent/tree和全部改动blob，不能只以API写入成功宣称已提交。
