# 真实 Agent 联调：执行顺序、阻碍与证据

2026-10-08 核对。此文是切片7的执行准备，**不是已经跑通的记录**。基线为切片6 `6b9dfb5500dbf0fb8e35c4d28d3b627069c1d66a` / tree `e58070db829b118128a84e5f6e84c826b854ddef`。本轮不改产品代码、不启用账号、订阅、部署或模型。

目标仍是[开发25](../development/25-agent-collaboration-delivery.md#slice-7)的两个真实成员、两个独立 Agent、至少一个真实远端，经 HEXU 完成求助、必要澄清、回答和原工作继续。使用[脱敏模板](agent-real-integration-evidence.template.json)记录结果；模板不是证明材料。

## 1. 已知结论与待验项

### dot 的静态 Bearer 不是已支持的插件认证

[OpenAI 插件认证](https://developers.openai.com/plugins/build/auth)明确写明 ChatGPT “nor can it present custom API keys”。该文档的认证 MCP 路径是 OAuth 2.1，包含资源/授权服务器 discovery、code + S256 PKCE、客户端注册或预定义 OAuth 客户端、token 验证及工具认证提示。OpenAI 管理的 mTLS 证书只识别客户端，不代替最终用户 OAuth。`noauth` 是匿名工具选项，不能用于 HEXU 的私有收件。

因此，**当前 owner-issued `hexu_receiver_` token 不符合官方所述的 ChatGPT 插件接入方式**。不是说所有未来平台方案都不可能，也不是一次真实安装失败的观测。预定义 OAuth client credentials 不是让 ChatGPT 任意携带 HEXU 静态 API token。

仓库事实：`agent-mcp-http.ts` 在 discovery 前也调用有限 receiver Bearer 认证；工具无 OAuth `securitySchemes`，缺资源 metadata 和工具 `_meta["mcp/www_authenticate"]`；`remote-collaboration.ts` 只开放现有有限路径。这是可定位的兼容缺口，不是把 token 粘进插件设置即可补齐。

### Codex 是另一条客户端路径

[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)支持本机 stdio 和配置 HTTP Bearer；不把此支持外推给 dot。HEXU 本机 requester 使用经典 stdio `2025-11-25`，再经显式 HTTPS requester API；无需为了 dot Events 把这条桥替换为 MCP2。

[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)支持在同一 thread 上继续或按已知 thread ID 恢复；[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)支持 `exec resume`。这些能力**不能证明当前用户桌面上已有的聊天可由新启动的 SDK/CLI 访问**。本轮没有访问该电脑、会话存储或运行模型。

[App Server](https://learn.chatgpt.com/docs/app-server)返回实际 `thread.id` 与 `thread.sessionId`；后者表示 live session tree root。fork 可能保留 sessionId 但产生新 thread，因此“session 相同”不够。恢复使用已记录的 thread ID，读取/恢复成功也不等于后续模型使用了回答。

### Events 有协议子集，尚无平台收件证据

[官方 Events](https://developers.openai.com/plugins/build/mcp-events)要求 MCP2 / `2026-07-28`，由客户端订阅并提供 webhook 配置；事件通知之后由 Agent 调用工具取当前状态。当前 HEXU 已有 discovery、有限事件、签名 challenge、TTL、加密订阅及持久 outbox 的无模型检查。平台是否安装成功、实际发出 subscribe、dot 是否被唤醒和调用回应工具，均未验证。不能自行填 callback/secret 模拟这几项。

## 2. 不可跳过的执行闸门

每项填 `not_run / blocked / pass / fail / inconclusive` 和可核对 evidence ref。缺必要权限填 blocked；有可核对反证才填 fail，例如错误thread、人工搬运或重复继续。负向用例中的预期拒绝算pass；请求可能已执行但结果缺失填inconclusive。不能以“已经配置”为pass。

| 闸门 | 通过所需事实 | 当前缺口 / 不通过时停止点 |
| --- | --- | --- |
| 环境 | 用户指定并批准测试 HTTPS origin、服务目标、证书和持久目录，明确到期/费用 | 未指定、未批准；不监听公网，不将现有 loopback 经代理/隧道公开 |
| 两个成员 | 两个独立真实成员分别授权其 Agent；身份映射来自认证记录 | 未配置；用户本人 Codex + 本人 dot 只能先算同成员跨环境，不可改名伪装第二人 |
| 有限分享 | 一个可丢弃 Task、A 的固定输入版本、B 可分享的专业知识及明确接收对象 | 未配置；不导出私人历史、整仓或其他成员资料 |
| dot 认证 | 真客户端完成受支持 OAuth，映射到 B 的有限 receiver authority | 当前无 OAuth 代码；止于兼容准备，不能降为匿名或借 browser Cookie |
| 客户端接入 | 本机 Codex 与当前 dot 实际版本/资格、批准的插件/MCP配置 | 未配置；不修改用户设备、安装插件或持续凭据 |
| 原工作身份 | 受支持宿主接口返回已选原聊天的 thread/session，绑定在求助前成立 | 当前仅环境变量自报；没有实际原聊天接口证据就停止消费验收 |
| Events | 用户批准持久订阅，真实客户端返回订阅ID/期限，challenge成功 | 未启用；不手造平台订阅，不把合成 callback 当 dot |
| 模型与预算 | 双方账户/模型、批准的使用上限与停止条件，至少一端实际远端 | 未批准；不代借密钥或启动计费调用 |

批准部署、OAuth注册、用户连接授权、有限资料分享、订阅及模型使用是不同决定。提供一个地址不等于批准全部动作。已有浏览器访问拒绝及暂停的原生/文件审阅仍有效。

## 3. 可交接的最小 OAuth 桥接任务（仅设计，未实现）

范围归属原 03-01/03/06、16-04/05/06、17-01；不新建工作项编号。先交付无真实账号可测试的代码，再等待真实注册/授权和部署决定。

### 是否复用 Better Auth

可以优先复用现有 Better Auth 身份引擎与经明确映射的 HEXU 用户，**不能直接公开现有 team-local handler**。当前锁定 `better-auth@1.7.6`，`packages/identity/src/index.ts` 仅允许 loopback，只有密码/会话与受邀开户，不包含 OAuth provider。

[Better Auth MCP](https://better-auth.com/docs/plugins/mcp)现提供独立 `@better-auth/mcp`，配合 `@better-auth/cimd` 与 OAuth provider 实现 discovery、PKCE、资源绑定及刷新；[1.7迁移说明](https://better-auth.com/docs/guides/1-7-upgrade-guide)指出 MCP 已迁出核心包。本仓库未安装这些包，也未验证其精确版本与现有 SQLite adapter 的兼容。后续先核 1.7.6 匹配包与迁移，不复制旧 1.6 示例、不自行编写密码/OAuth引擎，不无关升级全仓。

### 最小拆分与不扩权机制

1. 增加独立、显式 opt-in 的 OAuth issuer/consent 配置与测试组合。默认关闭；仅开放所需 discovery、JWKS、authorize/token、同意与撤销路径。公网登录/同意需要新隔离入口，不能放松现有 loopback、Cookie 或远端有限路由总闸。账号初始化和邀请保持受控，不新增公开 signup。现有身份库如何被获准测试实例使用必须在部署前确定。
2. 选择一个客户端注册方式。优先按实际平台给出的 CIMD/redirect 信息验证；也可选已配置的 OAuth client。不要把 CIMD、DCR 都无条件开启。CIMD/JWKS远程取件须有 SSRF、超时/体积、HTTPS和精确redirect约束；无凭据测试使用注入传输，不能请求任意地址。
3. 新 OAuth binding 由用户明确同意后关联 `(issuer, subject, client, resource)` 与**一个已批准有限 receiver connection及revision**。subject 必须来自可信令牌验证/受控身份映射，不能从请求body、email/display name、工具参数或模型自报取得。OAuth登录本身不能创建 delegation grant，也不能替所有者自动发行另一枚长期Bearer。
4. token验证和业务授权分层：先验证 issuer/audience/签名或可信introspection/时效/scope，再解析 binding；用现有 `agentReceiverConnectionById`/`revalidateAgentReceiverConnection` 重新检查 owner、成员、project、endpoint/capability/grant/version/到期。每次工具、业务事务、旧回执读取和事件发前都核当前条件。有效权限取 OAuth scope 与有限 connection scope 的交集；无 respond 不能回答。现有helper比较完整principal，必须保留原principal复验并单独检查有效scope，不能覆写actor.scopes后交给旧helper。
5. consent/refresh不能扩大项目、材料、能力、到期或连接代次；连接被撤销、成员退出再加入、能力改版均不可因旧 refresh token 复活。OAuth access token轮换不得变成新业务身份或重建订阅/重放工作。OAuth撤销如何抑制既有订阅需明确实现并验证，不能只依赖短 access-token TTL。
6. MCP2工具补 OAuth metadata/认证challenge，匿名只可读取必要公开discovery，不暴露工具调用结果、收件或材料。保留旧本机Bearer适配器，不将OAuth token塞给仅接受 `hexu_receiver_` 格式的旧函数；两种认证适配后才进入同一有限领域服务。不得变为通用HTTP代理。

建议交接切成两个小提交：A“认证库组合与discovery/consent契约”，B“有限主体映射、MCP challenge与订阅撤权”。只有代码/fixture与文档，未获准前不注册真实client、保存凭据、连接账号、迁移活动库或开启订阅。

### 无真实凭据的可测验收

使用独立临时 identity/business SQLite、虚构成员和短期测试签名材料，关闭网络发送与模型。新增定向测试，不运行全 `npm test/check/CI`。

- discovery的 resource/issuer、S256、注册方式、精确redirect；匿名不读业务数据；token错误触发正确MCP challenge，不返回原token或内部错误正文。
- 正确 code+PKCE 到有限身份；错verifier、code重放、错resource/issuer/audience、过期、缺scope、不同subject/不同client/不同connection映射均拒绝。OAuth正常刷新只保留原有限范围。
- 同意绑定不能选别人的participant或grant；当前成员撤销/重入、连接撤销/版本改变使新调用、旧业务回执及新投递失效；原Assistance历史仍可由有权父Task用户查看。
- 无respond只读、受限receiver不能读Task/Project/其他请求；OAuth adapter和原Bearer走同一个业务事务。原子失败不能留下半条映射/同意记录，不能顺便启动模型或另一Task。
- 新OAuth边界的有限401/challenge检查不恢复旧state-auth跨身份迟到401/403比较诊断；不运行#52、restore行为或被拒浏览器路线。允许的原MCP/receiver/events相关回归仅按新代码影响选取。

<a id="original-thread-evidence"></a>

## 4. 原线程接回的具体探测任务（尚待用户本机接入）

先只读核对选定设备、Codex版本和用户指明的已有聊天。只用该客户端支持的thread列表/读取/事件接口；**不读受禁会话目录、不猜ID、不从标题或cwd推导**。宿主由实际返回值建立绑定。读取不到该原聊天就记录 `existing_chat_access = blocked`，不能偷偷执行 `thread/start` 替代。

需要分别证明：

1. `origin_observed`：运行时返回的 exact thread ID、session ID、证据method/call ID、观测时间、当前environment；原工作目标及最早相关turn在求助前已存在。共享文件仅保留别名，真实值在获准本机证据中比较。
2. `origin_bound`：可信宿主把上述两个实际ID放入桥配置，原子 `hexu_create_request` 使用它们。记录运行时ID与HEXU binding相等的本机核对结果、创建回执与先后关系。写入环境变量本身不是来源证据。
3. `answer_received`：运行时的MCP工具call/item与HEXU认证审计使用同一request/response/input版本；答案是在模型工具返回中取得，不是人追加prompt。只记录相关工具字段，不导出整个转录或隐藏推理。
4. `work_continued`：同一原thread的后续item/turn产生可检查产物，确实使用了B独有的信息；原`sessionId`单独相等不算。记录真实turn终态与产物摘要/指纹，再与`external_self_report` ACK核对。ACK不升级为provider认证。

当前MCP启动配置没有自动取得宿主thread/session的接口。需要为**实际选中的客户端**补最小绑定适配，不要先承诺所有Codex入口支持。

可选技术路径：可访问同一线程存储的app-server宿主，从真实thread/read或start/resume结果取ID，在求助工具调用前完成绑定；消费保持原调用，必要时按已验证的同一thread/resume再turn/start。后者有额外恢复/费用/并发权限，不能自动开启。已有桌面聊天若不受该宿主支持，该路径判blocked。

[Hooks文档](https://learn.chatgpt.com/docs/hooks)提供runtime session/turn/tool-use字段，可作为关联线索，但子Agent的session信息不能替代exact thread证据。没有在此承诺hook能动态更改已运行MCP配置；安装hook也需获准。新SDK测试会话可另做适配器冒烟，记录 `origin_kind = new_controlled_test_thread`，**绝不能报作用户既有聊天接回**。

## 5. 获准后的真实闭环步骤

仅当本次目标所需闸门全部通过后执行。以下是工具/业务顺序，参数schema以运行客户端的 `tools/list` 与[当前实现](../../apps/mcp/src/tools.ts)为准，不填预设request/thread/token。

1. 冻结基线：记录Git SHA、实际客户端/协议版本、环境别名、批准引用及预算/截止条件。选择A确需B解释的有限接口问题；B拥有一项A事前未收到的、已获准分享的知识。A保有可以回答必要澄清的信息。不要让模型照背预写好的完整来回。
2. B完成受支持认证和明确receiver授权；dot由真实平台 `events/list`、`events/subscribe` 建立订阅。核对真实ID/到期/challenge，再 `hexu_list_requests` 同步当前收件。订阅中不能夹带问题正文、Task/Project或凭据。
3. A在用户选定原工作中取得可信origin；调用 `hexu_discover_capabilities`、`hexu_read_materials`、`hexu_preview_request`，以稳定operationKey调用 `hexu_create_request`。立即核对同一Task/目标/输入版本以及已原子创建的binding。
4. B收到平台通知后自主 `hexu_get_request` / `hexu_read_materials`，经 `hexu_respond` 保存必要的 `request_input`。记录event ID、平台通知观测、dot实际tool call与HEXU response分别对应，不能以callback 2xx代替后三者。
5. A自主查询原请求，使用已批准原材料与上下文，经preview和 `hexu_revise_input` 补充；`causeResponseId`精确指向B的澄清，expected revisions/hash来自当前读取。若必须新增未授权材料，暂停征询；本次“无人搬运”链不得假装未暂停。
6. B取得新input revision，`accept`后保存 `answer`；A用 `hexu_wait_answer`/当前读取得到该answer，再用固定binding/response/input/access版本 `hexu_consume_answer`。仅first可继续一次；replay或unknown不能触发第二次执行。等待受原30秒单调用界限与批准的总体费用/截止条件约束。
7. A在同一原工作中产出使用B知识的结果；从真实runtime观察相关item/turn和终态后核对ACK。原Task投影记录回答、claim与自报输出，人工采用非必要，不为了验收改Task完成状态。
8. 审核证据并输出分项结论；按批准范围停止测试订阅/连接，记录撤销或自然到期的实际状态。停止外部执行只能按各客户端真实终态确认，不能用HEXU取消当证明。

全过程只有人提供起始目标、批准与最终审核；人若在中间复制问题、澄清或答案给另一端，`human_relay_observed = true`，首个里程碑判fail。收集证据不得主动产生中间业务消息。

## 6. 证据模板的填写与判定

模板中的null不是false，不填默认成功。`evidence`每条只存别名、UTC时间、观察者/来源类别、精确method、相关record/item引用与结论；所有被引用ID必须在数组中存在。记录同一类型事实的双方观察，不只填检查项boolean。

`evidence`记录字段固定为：`id`（本文件唯一别名）、`observedAtUtc`、`sourceKind`（`provider_runtime / hexu_authenticated_record / platform_event / approved_artifact_review / authorization`）、`observerAlias`、`method`、`relatedAliases`（仅本次成员、Task、request、input、response、thread、session、turn、item或operation别名）、`finding`（简短脱敏事实）、`sourceCheckedBy`、`sourceCheckedAtUtc`。身份来自哪个认证入口、输入/回答版本如何相等、artifact如何应用知识，应分别写入finding并有双方record关联；仅填“通过”不合格。实际填报时设置 `templateOnly = false`，保留事实版本，不能因此自动改verdict。

| 断言 | 必填关联证据 | 不足或失败示例 |
| --- | --- | --- |
| 跨成员/环境 | 认证member别名A≠B；两端host/client别名；真实远端调用来源 | 同用户两个注册participant不算跨成员；fixture socket不算跨设备 |
| 经HEXU澄清 | 原request→B request_input→A新revision/cause→B answer；每一步认证actor和工具call | 人工粘贴、另开聊天、相同显示名，或新建第二request完成来回 |
| 原工作绑定 | 求助前runtime返回ID→host配置→不可变binding；exact thread和session双核对 | 只填env、预设ID、answer后补binding、只比session |
| 实际消费 | answer/input版本→claim(first)→原thread tool result→后续产物→provider turn终态 | callback2xx、claim、ACK或“我继续了”单独存在 |
| 答案有用 | B独有事实未提前传给A；产物应用该事实的局部语义检查 | 只在输出里机械重复答案或双方初始prompt已包含答案 |
| 无重复执行 | 同一operation/request/claim，后续runtime调用数与原计划一致 | unknown后换key/新开线程，未查状态就重跑模型 |

`verdict.real_cross_member_loop`仅在所有核心断言均有可审查证据且通过时填pass；其中任一真实环节未跑即not_run/blocked，证据不足为inconclusive。`existing_desktop_chat_continued`、`real_browser`和`production_deployment`独立判定，不能互相提升。

模板只保存脱敏索引，不自动证明来源。审核者必须在授权来源实际核对相关原始运行时/服务记录，再登记核对者与时间。哈希/别名/UTC先后或boolean都不是密码学证明；不建立伪造provider签名。

真实证据不直接提交仓库：禁止token、Cookie、auth header、OAuth code/verifier、callback URL、whsec、原始session/thread、私人prompt/完整转录、隐藏推理、数据库或截图。使用随机别名并在获准本机保留最小映射；敏感内容不因做hash就自动可分享。产物内容与指纹只对本次明确可分享的材料记录。费用只写本次来源与已知值/unknown，不导出账户余额。

## 7. 异常验证与停止条件

先记录已有片1—6 fixture结果，不追溯称为真模型。真实异常仅限另行批准的测试请求，不能破坏正在进行的主链。

- 业务拒绝：B真实decline保存在原request，不消费、不启动继续。
- 离线：期限内保留等待；恢复只查当前request，不能以旧通知顺序推断接受。
- 撤权：确认后续读/写/投递被拒，已发网络请求及已交付文本不可收回；不推断外部模型已停止。
- 未知响应：仅查原receipt/当前request/consumption；若claim已存在而provider继续未知，停止自动继续并保留unknown。不得为补证重跑原工作。
- 重复回应：同键同包只保留一条业务结果；不把通知重试当第二次模型任务。无获准故障注入条件则留not_run。

出现认证/权限拒绝、不可确认原thread、预算或时限到达、未知模型执行、缺第二成员或需新增材料/费用时停止依赖步骤，保留事实。不得重试此前拒绝的浏览器/隧道路线、旧state-auth诊断或#52/restore行为。完整部署运营、所有厂商适配及自动跨回合唤起不属于本准备片。
