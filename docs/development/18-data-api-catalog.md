# 18｜公共数据、API 与事件目录

> D1 · 跨工作包契约草案，不是已上线 API。  
> [计划入口](README.md) · [工程基础](01-foundation-contracts.md) · [产品领域规则](../product/05-domain-and-state.md)

本页包括完整目标草案和按批次追加的实现子集。历史小节中的“当前/未实现”只指对应时期；实际请求 schema 以 [contracts](../../packages/contracts/src) 和 [控制 API](../../apps/control/src) 为准，交付范围看 [21](21-implementation-status.md)，不要从旧小节推导当前缺少已完成能力。

## D2：跨 Agent 协作的最小公共契约

以下配合 [25 的交付拆分](25-agent-collaboration-delivery.md)，描述完整目标草案；本轮实际身份/能力/只读连接子集单列在下一节，不由逻辑工具名推定已上线接口。先实现有限只读协助，再扩展分支/接手；一个逻辑操作在 HTTP、MCP 或所选远端协议上调用同一业务服务。

| 概念 | 最小字段/关系 | 归属与边界 |
| --- | --- | --- |
| AgentParticipant | id、space、owner、可选原生实例引用、revision、可参与范围 | 03/16；稳定参与身份，区别于真人成员和执行配置 |
| AgentEndpoint / Connection | participant、端点/协议版本、凭证引用、接收/查询方式、最后核对时间 | 16；地址、凭证与身份分别管理，换凭证不改作者 |
| Capability | participant/endpoint、用途、input/output、版本、接收条件、费用主体、三维可用状态 | 16；提供方支持、HEXU 适配、本次授权/环境分开，不以端点自报代替验证 |
| DelegationGrant | 发起/接收主体、允许能力与材料/输出范围、到期、策略版本、有限自动接受、资源限制 | 03/11；先一层只读协助，不借转发扩大权限 |
| CollaborationRequestRef | id、businessRef、双方身份、输入/授权版本、root/parent、远端引用、投递观测 | 11/16；businessRef 首轮只指 Assistance，不复制 Task 或完成状态 |
| 协商回应 | request、固定输入版本、accept/decline/request_input/propose_scope/answer、正文或产物、真实 actor、revision | 11；新输入另建修订，接受不等于实际开工 |
| ExecutionRef | connection、远端 job/session/turn、来源、观测与时间 | 07/16；不受管外部执行不伪造 Run 或进程事实 |
| 结果消费关联 | request、reply/ResultRevision、输入版本、目标原工作/Run 或外部执行引用、事实来源 | 11/14；区分输入绑定、可观察后续产出与 Agent 自报，不自动采用共享决定 |

首轮业务状态仍属于 Assistance；接受/拒绝/澄清等回应及投递记录形成可读投影。协作记录不再维护一份与 Assistance/Run 竞争的完整生命周期。后续引入 WorkBranch/Handoff 时分别保留原领域后果。新增表或嵌入字段的选择在实际 schema 中确定，不按概念一对一创建服务或表。

| 逻辑动作草案 | 作用 | 主要控制 |
| --- | --- | --- |
| capabilities.search | 查找当前可发现的能力 | 返回有限信息，无隐式读取资料或开工 |
| context.read | 读取本次获授权材料版本 | 权限与授权版本复核，有限接收者不获得父 Task/Project 元数据 |
| collaboration.request | 创建指定能力的协助请求 | 当前 Task 操作权、材料披露、双方预授权与幂等；正文不能指定虚假身份 |
| collaboration.respond | 接受/拒绝/澄清/提议范围/回答 | 固定输入版本和当前接收方身份；超出授权不执行 |
| collaboration.list / get | 查询自身相关请求和原请求结果 | 范围、分页、游标、当前权限；知道 ID 不授予访问 |
| collaboration.cancel | 撤回请求或取消本平台后续动作 | 关联实际执行另发停止，返回各层实际结果 |
| results.publish / read | 保存或取得授权范围内版本化产物 | 短回答可直接存协助回应；不隐含 Task 完成或代码写入 |
| human.request_input | 把明确业务/授权缺口交给相应人 | 不把普通 Agent 交流变成逐步审批 |

工具面按切片开放，具体 HTTP 路径、MCP 名称和严格 schema 在切片 1/2 锁定并随源码维护。协作凭证、浏览器会话和节点身份分别校验；有限接收者只看到不透明协助引用及明确分享内容。

写入绑定作用域内的稳定请求键、正文哈希和 expectedRevision；业务记录/授权/回执/outbox 同事务。查询或回执先核对当前权限。远端超时先查原标识，不以本地幂等键声称远端恰好执行一次；事件保留来源与顺序，不能由迟到事件反转确认事实。

首次原生回接可以使用 Agent 自身有界查询/等待，或实际适配的继续接口；输入绑定与实际消费分别留证。重启不自动启动结果未知的付费工作。MCP、A2A 和 provider 方法名均不能由上述逻辑名称推定。

## 1. 本文权威范围

01—17 中的接口名称、字段和事件以本草案统一。实现开始后以 packages/contracts 的版本化 schema 和生成文档同步维护。产品行为仍以 v1.1 为准，本表不重新引入 Evidence/Acceptance。

默认 HTTPS JSON，前缀 `/api/v1`；浏览器会话用受保护 Cookie，节点使用自己的受限身份。代码中 `spaceId` 对应产品 Workspace；`workingCopyId` 指具体代码现场。二者不可互换。

## 2. 通用字段与作用域

对象 ID 不透明，底层可用 UUID。业务表有 id、space_id、created_at、updated_at，需并发修改的表有 revision。关联尽量使用 `(space_id,id)` 复合外键或等价服务端约束，阻止错误跨租户引用。

Task 使用 visibility=private/project，projectId 可空。个人任务默认 ownerUserId 为创建者；待分配团队任务可留 todo，开始真实执行时由有权限的人承担责任。

私有历史与被分享快照各自有访问范围，不只依赖当前 Task.visibility。Task 转为共享后不能让历史消息、原生会话、附件和搜索摘要自动全部公开。有限 AccessGrant 明确资源快照、接收者、操作集合、到期与撤销。

来源使用 actorType=human/agent/system/rule，并保存对应 ID，不能让 Agent 调用时冒充用户点击。配置快照保存实际 model、工具/适配器版本与 accountRef，但不存裸密钥。

## 3. 表组与迁移归属

| 所属计划 | 表组草案 | 关键约束 |
| --- | --- | --- |
| 01 | schema_migrations、outbox、idempotency_records、attachments | 幂等键+主体+动作唯一；payload hash 防同键异义 |
| 03 | spaces、memberships、invitations、projects、project_members、project_repositories、resource_grants | 成员/项目范围；邀请原子消费；凭证独立 |
| 04 | tasks、task_participants、task_dependencies、task_attention、requirements、requirement_revisions、requirement_tasks、milestones、completion_events | Task 状态有限集合；修订不覆盖；完成不依赖报告 |
| 05 | sources、source_revisions、agreements、agreement_revisions、discussion_threads、messages、ai_drafts、context_bundles、context_items | 每个内容对象保留访问范围和引用版本 |
| 06 | nodes、node_grants、working_copies、node_resources | 同 node 的规范化现场避免重复注册 |
| 07 | agent_profiles、runs、native_sessions、run_inputs、run_events、dispatches、working_copy_leases、action_authorizations | 同现场单活跃写入；事件来源序号去重 |
| 10 | terminal_sessions、user_layout_preferences | 终端输入权与 Task 查看权分开 |
| 11 | continuation_operations、assistances、assistance_responses、access_grants | 协助不转移 owner；响应仅进入所选线程 |
| 12 | checkpoints、checkpoint_items、handoffs、share_operations | 发布前材料完整；恢复成功再原子接手 |
| 13 | work_branches、integration_operations | 固定共同起点；选择不等于合并或停止 |
| 14 | results、result_revisions、feedback_threads、feedback_messages、preview_sessions、release_references | revision 不可覆盖；预览身份独立 |
| 15 | notification_items、notification_preferences、search_documents、usage_observations、cost_adjustments、budget_policies | 投影可重建；金额 decimal+currency；unknown 不为零 |
| 16 | workflow_templates、template_revisions、workflow_instances、step_instances、connections、external_references、integration_inbox、automation_rules | 实例锁版本；Webhook delivery 去重 |
| 17 | runner_releases、maintenance_jobs、retention_policies | 维护不改任务完成语义；升级记录来源 |

表名是建议，不要求一次性建完所有表。01 先提供公共设施，业务包各自提交迁移；数据库 owner 协调编号与依赖。身份组件自带的 auth 表不再重复建设。

## 4. 主要对象形状

```ts
// 拟实现契约；ID 示意，不是现成代码包。
type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
type Observation = 'fresh' | 'stale' | 'unknown';
type RunState = 'queued' | 'preparing' | 'running' | 'waiting_input'
  | 'waiting_approval' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
interface Task {
  id: string; spaceId: string; projectId: string | null;
  visibility: 'private' | 'project'; title: string; description: string | null;
  ownerUserId: string | null; operatorUserId: string | null;
  status: TaskStatus; revision: number; archivedAt: string | null;
}
interface Run {
  id: string; taskId: string; purpose: 'main' | 'assist' | 'parallel' | 'template';
  state: RunState; observation: Observation; lastConfirmedAt: string | null;
  nodeId: string; workingCopyId: string | null; contextBundleId: string;
  previousRunId: string | null; nativeSessionRefId: string | null;
  configSnapshotId: string; revision: number;
}
```

内容较大的字段与敏感原生引用通过有权限的独立读取接口获取，不直接塞入列表 DTO。TaskSummary 可附 derived `activeRuns` 与 `attention`，这些不是第二套可写状态。

WorkingCopyLease 使用 writerType=run/terminal/integration、writerId、generation、有效期和 terminationConfirmed。终端/整合操作与 Run 竞争同一个受管写入范围；服务租约到期不等于宿主进程已经结束。

## 5. HTTP 路由目录

下列路径均省略 `/api/v1`。GET 是读取，POST 为创建或明确动作；修改内容 PATCH 需 expectedRevision。返回结构、权限与业务结果使用运行时 schema，不能只写前端类型。

| 计划 | 路由组 | 核心字段/行为 |
| --- | --- | --- |
| 03 | `GET /me`；`GET,POST /spaces` | 当前身份与可见空间 |
| 03 | `POST /spaces/:spaceId/invitations`；`POST /invitations/:token/accept` | 短期邀请；日志脱敏 token |
| 03 | `GET,POST /spaces/:spaceId/projects`；`GET,PATCH /projects/:projectId` | 项目成员/仓库子资源同范围 |
| 04 | `GET,POST /spaces/:spaceId/tasks`；`GET,PATCH /tasks/:taskId` | title 最小创建；projectId 可选 |
| 04 | `POST /tasks/:taskId/complete`、`reopen`、`cancel`、`archive` | expectedRevision；activeRunAction |
| 04 | `GET,POST /projects/:projectId/requirements`；`PATCH /requirements/:id` | 可选需求与修订 |
| 04 | `POST /tasks/:taskId/dependencies`；`GET,POST /projects/:projectId/milestones` | 依赖循环提示、轻量目标 |
| 05 | `GET,POST /tasks/:taskId/messages`；`PATCH /messages/:id` | actor、附件、thread、目标修订 |
| 05 | `GET,POST /projects/:projectId/sources`、`agreements` | 来源、版本、范围；AI 草稿另存 |
| 05 | `POST /tasks/:taskId/context-bundles`；`GET /context-bundles/:id` | purpose、selectedRefs、目标配置 |
| 01/05 | `POST /attachments/uploads`；`POST /attachments/:id/finalize` | 先临时上传再关联；读取重新鉴权 |
| 06 | `POST /node-pairings`；`POST /nodes/register`；`GET /nodes` | 一次配对，限制节点归属 |
| 06 | `GET,PATCH /nodes/:nodeId`；`POST /nodes/:nodeId/revoke` | 健康、能力和未来派发撤销 |
| 06 | `POST /nodes/:nodeId/working-copies`；`GET /working-copies/:id` | 获准本地目录/仓库，不是任意文件 API |
| 06/10 | `GET /working-copies/:id/files`、`diff` | 路径在查询中编码并按授权根解析 |
| 07 | `POST /tasks/:taskId/runs`；`GET /runs/:runId` | 配置、节点、输入、reopenTask |
| 07 | `POST /runs/:runId/inputs`、`stop` | 送达结果与停止请求结果分开 |
| 07 | `POST /authorizations/:id/resolve` | 原生请求、generation、scope、有效期 |
| 07 | `GET /tasks/:taskId/events?after=cursor` | SSE；权限过滤，游标恢复 |
| 08/09 | `GET /nodes/:nodeId/agent-capabilities`；`GET,POST /spaces/:spaceId/agent-profiles` | tool/model/credentialRef/location 分层 |
| 10 | `POST /working-copies/:id/terminals`；`POST /terminals/:id/close` | 输入另走授权 WS；租约独立 |
| 11 | `POST /tasks/:taskId/continuations`；`GET /operations/:operationId` | 同机接续自动准备，仅缺项展开 |
| 11 | `POST /tasks/:taskId/assistances`；`GET /assistances/:id`；`POST /assistances/:id/responses`、`cancel` | 选择材料与有限访问，不改任务 owner |
| 12 | `POST /tasks/:taskId/checkpoints`；`GET /checkpoints/:id` | 多仓库提交/补丁材料 |
| 12 | `POST /tasks/:taskId/handoffs`；`POST /handoffs/:id/offer`、`accept`、`reject`、`withdraw` | 接手与启动分开，责任转移显式 |
| 12 | `POST /tasks/:taskId/share-previews`、`publish` | 分享范围预览和实际发布分开 |
| 13 | `GET,POST /tasks/:taskId/work-branches`；`POST /work-branches/:id/select`、`discard` | 选中不自动停止/合并 |
| 13 | `POST /tasks/:taskId/merge-operations` | 目标现场、源结果版本、所选改动 |
| 14 | `GET,POST /tasks/:taskId/results`；`GET /results/:id`；`POST /results/:id/revisions` | 持续产出与不可变版本 |
| 14 | `POST /results/:id/feedback`；`POST /feedback/:id/follow-up` | 锚定版本；是否新建任务由用户选 |
| 14 | `POST /working-copies/:id/previews`；`POST /previews/:id/access-session`、`stop` | 受控端口、独立预览凭证 |
| 14 | `POST /tasks/:taskId/release-references` | 发布引用，不等于触发部署 |
| 15 | `GET /workbench`；`GET /projects/:id/overview` | 同源 Task/Run/Result 聚合 |
| 15 | `GET /notifications`；`POST /notifications/:id/read`；`PATCH /notification-preferences` | 已读不是已回复/已批准 |
| 15 | `GET /search`；`GET /usage`；`GET,PATCH /spaces/:id/budget-policy` | 权限过滤；费用来源与未知 |
| 16 | `GET,POST /spaces/:id/templates`；`POST /templates/:id/revisions`、`start` | 锁模板版本并复用 Run |
| 16 | `POST /workflow-instances/:id/continue`、`skip`、`cancel` | 子 Run 的真实状态继续保留 |
| 16 | `GET,POST /spaces/:id/connections`；`POST /connections/:id/revoke` | 供应商资源范围，凭证引用 |
| 16 | `POST /webhooks/:connectionId/:provider` | 独立签名验证，不使用浏览器会话信任 |
| 17 | `GET /maintenance/health`；`POST /maintenance/jobs` | 相应管理权限，任务异步返回 |

`/health`、`/ready` 的公开探针仅返回最少运行信息，不能泄露节点或业务数据。维护详情与普通探针分开。表中简写的兄弟动作共享左侧基路径，不是在根路径增加 `/reopen` 等入口。

## 6. 命令与长操作的语义

创建等成功使用 201；长操作接受使用 202 + operationId；读取/已完成幂等重放返回稳定结果。400 是格式、401 登录、403 可明确告知的权限不足、404 不可见资源、409 修订/现场冲突、422 配置不可用、429 配额/速率、503 暂时不可达。

Operation 公共形状为 kind、status（queued/running/waiting/succeeded/failed/cancelled）、stage、blockers、resultRef。继续中的 waiting_for_stop 是 stage，不能据此改 Run.state；Handoff/WorkBranch 的领域状态各自保留。

```json
{
  "operationId": "op_demo",
  "kind": "continuation",
  "status": "waiting",
  "stage": "waiting_for_stop",
  "blockers": [{"code":"SOURCE_RUN_ACTIVE","action":"wait"}],
  "resultRef": null
}
```

通用错误码至少包括 REVISION_CONFLICT、WORKING_COPY_BUSY、NODE_UNREACHABLE、CAPABILITY_UNAVAILABLE、NATIVE_SESSION_UNAVAILABLE、CONTEXT_ACCESS_CHANGED、CHECKPOINT_INCOMPLETE、AUTHORIZATION_EXPIRED、BUDGET_POLICY_BLOCKED。错误详情按访问权过滤。

## 7. 节点命令和事件

节点 WSS 入口 `/api/v1/nodes/connect` 只接受已登记节点凭证，验证 Origin/身份策略；终端 WS 与预览隧道使用独立 scope，不能复用任意节点命令权。

```json
{
  "protocolVersion": 1,
  "messageId": "msg_demo",
  "kind": "run.start",
  "nodeId": "node_demo",
  "runId": "run_demo",
  "dispatchId": "dispatch_demo",
  "generation": 7,
  "payload": {"workingCopyId":"copy_demo","configSnapshotId":"cfg_demo"}
}
```

命令至少 run.start/run.input/run.stop/authorization.resolve/workspace.inspect/checkpoint.restore/preview.open/terminal.open。宿主处理前检查 scope 与 generation，不把任意 payload 直接拼成 shell。

```json
{
  "eventId": "evt_demo",
  "schemaVersion": 1,
  "spaceId": "space_demo",
  "taskId": "task_demo",
  "runId": "run_demo",
  "nodeId": "node_demo",
  "source": "runner",
  "sourceSequence": 42,
  "processGeneration": 7,
  "occurredAt": "2026-09-25T06:32:00Z",
  "receivedAt": "2026-09-25T06:32:01Z",
  "type": "run.state_changed",
  "payload": {"state":"succeeded","reason":"native_turn_finished"}
}
```

上例是虚构结构。协议约束与字段应由 schema 生成；消息大小、附件引用和保留方式可配置，不把全部原生日志复制进每个事件。

业务事件：task.created/updated/completed/reopened、message.created、agreement.updated、assistance.responded、handoff.accepted、result.revision_created、work_branch.selected、notification.updated。它们不自动相互等价，run.succeeded 不生成 task.completed。

## 8. Adapter 能力草案

```ts
interface Capability {
  level: 'supported' | 'partial' | 'unsupported' | 'unverified';
  reason?: string;
}
interface AgentAdapter {
  discover(input: DiscoveryContext): Promise<AgentCapabilities>;
  start(spec: RunSpec, host: AdapterHost): Promise<RunHandle>;
}
interface RunHandle {
  events: AsyncIterable<AdapterEvent>;
  sendInput(input: RunInput): Promise<InputReceipt>;
  resolveAuthorization(decision: AuthorizationDecision): Promise<void>;
  requestStop(): Promise<StopReceipt>;
}
```

以上引用类型由 01 建立，不是可直接导入的现有代码。resume 是 RunSpec 的显式模式并由 capability 描述；无原生恢复时新会话不能冒充恢复。有效能力取原生能力、宿主隔离和用户策略共同允许范围，不只看 CLI 是否存在。

## 9. 状态与事务底线

完成命令不查询测试覆盖率。源码变化不自动撤销历史完成。启动 done 任务需显式重新打开。正文/评论不产生授权。相同幂等键不创建重复 Run，旧 generation 不消费新授权。

对外部命令无法只靠数据库保证恰好一次；结果未知先对账。版本化结果与活动现场分开；只读协助不取得主现场写入权。跨空间分享的建议边界见 12 与 DD-07。

## E1b 当前实现子集

已实现同机显式跨工具继续及上下文/Git 摘录。`POST /tasks/:taskId/continuations` 当前同步准备后返回 `201 + Run`，含 sourceRunId；GET continuation-preview 供页面查看来源。持久化 Operation、后台等待后自动开始、跨节点恢复和临时协助仍未实现；源执行活动时先停止，确认后由用户开始。未变更最终目标，也不要求额外业务审批。

实际使用与限制见 [原生说明](../engineering/native-execution.md)，最新进度见 [21](21-implementation-status.md)。


## E1c 实现子集：本机接续 Operation

以下是当前代码，不替代上文的完整团队契约。仅本机示例主体，没有正式会话/成员授权；类型源为 `packages/contracts/src/continuation.ts`，数据库为 SQLite 迁移 3。

| 路由 | 当前语义 |
| --- | --- |
| `POST /tasks/:taskId/continuations` | `202` + ContinuationOperation；Location 指向 `/api/v1/operations/:id` |
| `GET /tasks/:taskId/continuations` | `{ items }`，最近 20 项，包含保留要求与来源 |
| `GET /operations/:id` | 操作当前状态、revision、blockers、runId |
| `POST /operations/:id/cancel` | 必须有 expectedRevision 和幂等键；尚未创建目标 Run 时取消 |
| `POST /tasks/:taskId/runs` | 仍为 `201` + Run；直接路径也核对待接续任务/目录预约 |

接续输入沿用显式原生配置，必须有 sourceRunId、workingCopyId、requestedTool、prompt、expectedRevision、confirmExecution=true；另必须选择 `onActiveRun=wait/request_stop`。已完成任务需要显式 reopenTask。密钥只来自本机独立配置，不接受由任务文本或 Operation 传入。

状态是 waiting_for_stop / preparing / needs_attention / succeeded / cancelled / failed。succeeded 仅说明新 Run 与操作关联已经原子提交；Task 和 Run 仍各自表达完成与执行结果。开始后的操作取消返回 RUN_ALREADY_STARTED，随后使用 Run 停止动作。

本机实现将人工说明变化、任务修订变化、未知源进程、目录占用、目标能力缺失、等待过期变为明确阻碍；不会因此转移责任、跨目录、扩大权限或自动改用其他账号。重启不重试待开始的付费执行。完整 AccessGrant、Operation 跨节点调度与共享上下文选择仍未实现。

## E2a 实现子集：真实账号与访问范围

只在 team-local 启用，仍为回环服务。`GET /identity` 返回模式、初始化状态、当前用户和空间；POST `/identity/setup`、`sign-in`、`sign-out`、`change-password`、`revoke-sessions`、`invitation-preview`、`join` 是明确允许的认证入口。原始 `/api/auth` 不开放，不返回页面可读取的 session token。

业务请求用 HttpOnly Cookie 认证及 `X-Hexu-Space` 选择当前已加入的空间；SSE 以 spaceId 参数选择但仍由 Cookie 校验成员关系。写入要求来源、客户端标识和现有业务幂等键。POST `/spaces` 建团队；GET/POST `/spaces/:spaceId/invitations`、POST `.../:invitationId/revoke`；GET `/spaces/:spaceId/members`、POST `.../:userId/remove`；GET `/projects/:projectId/members`、POST `.../:userId` 配置 view/edit/manage 或 null 移除。完整输入以 contracts/identity 和 control/identity 代码为准。

直接 Task/Run/Result/Operation、列表、搜索与事件受同一权限约束。既有普通任务、讨论、文字成果和完成接口在团队空间可用。原生资源、上下文预览、全部 Run/接续派发在团队模式返回 RUNNER_REQUIRED，不以登录赋予本机文件或模型权限。正式节点、附件 AccessGrant 与跨空间发布仍未实现。

## E2b1 实现子集：独立节点摘要

浏览器使用真实会话的 `GET /nodes`（items/pairings）、`GET /nodes/:nodeId`、`POST /nodes/pairings`（projectId，幂等键）、`POST /nodes/pairings/:nodeId/cancel`、`POST /nodes/:nodeId/revoke`（expectedRevision，幂等键）。配对码仅第一次创建返回，记录和重放不返回明文。

独立进程使用 `/runner/v1/` 的 POST pairing-preview、pair、hello、sync、goodbye、disconnect。配对接口消费短时随机码，其余接口验证专用节点 Bearer；请求不使用浏览器 Cookie/Origin，不能调用 /api/v1 的业务接口。hello 返回固定协议版本、项目、连接代次和 ACK 水位；sync 只接受固定目录 ID 的数量摘要。没有 execute/dispatch/stop 命令。

输入类型以 `contracts/src/nodes.ts` 为准；未知字段、额外目录、序号冲突和跳号均拒绝。API 不接受本地路径、文件内容或模型密钥。此 ACK 不代表 Run 接单、进程启动或模型成功。

## E2b2 实现子集：独立节点本人执行

浏览器 `GET /tasks/:id/node-options` 返回本人已授权节点、固定工具/模型/目录/限额和待发送任务材料。`POST /tasks/:id/runs` 的 provider=node 输入 nodeId、workingCopyId、policyHash、mode、prompt、expectedRevision、reopenTask、confirmExecution；返回 201+Run。权限先于幂等重放检查。既有 Run stop 和 Task 状态接口联动派发，Task 完成不由 Run 文本决定。

节点 Bearer 通道 `/runner/v1/execution-policy` 发布本机明确的有界策略；`execution-poll` 获取固定派发；`execution-permit` 消费单次启动许可；`execution-event` 持久化 accepted/running/output/terminal/unknown 及序号。正文严格拒绝额外字段；没有文件路径、可执行参数或 API key。节点只支持一个活动派发，许可失联不会重发 launch。

类型源为 contracts/node-execution.ts，业务迁移 6。节点凭证被撤销后仅对原绑定派发排空事件并提交停止证据，内容丢弃，不重新发布策略或领取任务。只读成员不能派发或停止；项目编辑者可停止既有执行，派发额外要求节点所有者。完整他人授权/AccessGrant、原生 resume/steer、远程传输仍未实现。

## E2b3 已实现接口

GET /tasks/:taskId/next-inputs 返回任务可见范围内的待处理/历史要求；node 的 POST /runs/:runId/inputs 接受 {body} 返回 {delivery:queued_for_next_turn,input}。PATCH /next-inputs/:id 接受 {body,expectedRevision}；POST /next-inputs/:id/cancel 接受 {expectedRevision}；修改均需原作者及任务编辑权限，业务幂等键不变。

GET /tasks/:id/node-continuation-preview?sourceRunId=... 仅供节点所有者，返回固定来源/节点/目录、材料与哈希、ready/blockers。POST /tasks/:id/runs 的 node 输入可增加 continuation {sourceRunId,expectedContextHash,inputs:[{id,revision}]}；未加则保留原执行创建语义。节点续接返回 201+Run，不冒充 preview 的 202 Operation。请求严格校验额外字段，材料和要求状态在同一事务再核对。


## E2b4 实现：节点持久化接续

`POST /tasks/:taskId/continuations` 在真实账号模式接受 provider=node 的现有 NodeRunInput、continuation 选材，以及必填 onActiveRun=wait/request_stop，返回 202+NodeContinuationOperation 和 Location。未知参数由严格 schema 拒绝。预览用 `GET /tasks/:id/node-continuation-preview?sourceRunId=...&waiting=true`；可预约配置用 `GET /tasks/:id/node-options?sourceRunId=...`，这不授予跳过来源检查的执行权。

`GET /tasks/:id/continuations` 返回最近 20 个安排；`GET /operations/:id` 返回当前记录；`POST /operations/:id/cancel` 要求 expectedRevision/幂等键及任务编辑权限。Run 已创建返回 RUN_ALREADY_STARTED，应走 `/runs/:id/stop`。新增 SQLite 迁移 8，唯一活动 task/node 预约；普通 Run 创建也核对。

状态 waiting_for_stop / preparing / needs_attention / succeeded / cancelled / failed 复用已有标签。succeeded 仅指派发事务创建了 Run。记录固定已授权全文和本机策略，不存模型 Key；服务恢复不重放付费执行。旧 preview Operation 读取/权限行为保留，两个数据模式不自动导入互换。

## E2c1：Codex 原生恢复子集

本机 ExecutionPolicy 可选 retainSessions:true（仅 Codex）。节点 DispatchCommand 可携带由服务端根据已验证来源构造的 session:{ref,sourceDispatchId}，不接受浏览器原生 threadId、history 或路径。POST /tasks/:id/runs 允许 sessionMode=resume，必须提供最新成功来源、材料哈希和明确执行授权；POST continuations 拒绝该模式，自动等待仍新会话。成功终态节点事件可带 nativeSession:{ref,action,expiresAt}，服务端核查来源及策略。原生 thread/turn/model 和 Key HMAC 只在节点私有 SQLite/文件保存；任务权限不提供原生文件访问。

## 05-03 实现子集：从讨论保存项目约定

`GET /tasks/:taskId/messages/:messageId/agreement-preview` 返回同项目公开讨论的有界来源预览及完整消息指纹；`GET /tasks/:taskId/agreements-notice` 返回当前项目的有效数量和变更版本。`GET/POST /projects/:projectId/agreements` 读取/发布，`GET/PATCH .../:id` 读取/修改，`POST .../:id/lifecycle` 停用/启用，`GET .../:id/revisions` 读取不可变历史。具体字段和限制见 [约定契约](../../packages/contracts/src/project-agreements.ts) 与 [使用说明](../engineering/project-agreements.md)。

迁移 14 增加独立约定、修订和项目变更版本。发布需 sourceTaskId/sourceMessageId/expectedSourceHash；可选 replaces 绑定同项目有效约定的 id/expectedRevision，新旧状态与历史/outbox/回执同事务。private/foreign/system 来源拒绝直接发布，源权限在旧回执前重新检查。约定不自动进入模型材料，任务内提示不代表持久通知或 provider receipt。

## 05-02 实现子集：项目文本资料与链接

`GET/POST /projects/:projectId/sources` 读取分页列表或创建文本/链接；`GET/PATCH /projects/:projectId/sources/:sourceId` 读取当前资料或按 expectedRevision 完整修改内容；`POST .../:sourceId/lifecycle` 明确 delete/restore；`GET .../:sourceId/revisions` 按不可变修订分页。完整字段及限制见 [项目资料契约](../../packages/contracts/src/project-sources.ts) 和 [使用说明](../engineering/project-sources.md)。

SQLite 迁移 13 增加 project_sources/project_source_revisions。资料有独立 ID、revision、contentHash、创建/更新者和删除标记，不修改父项目/任务修订或模型材料。当前项目 view 可读、edit/manage 可写，历史/搜索/回执/SSE 同范围；重放前及事务内复核当前权限，记录、历史、项目 outbox 和回执原子提交。删除可恢复且保留历史；不允许请求改变类型/归属/作者或永久清除。链接不触发网络抓取，附件上传尚未交付；约定与明确模型选材见对应实现子集。

## 05-05/06 实现子集：项目选材与执行快照

`GET /tasks/:taskId/project-materials` 返回当前可读的同项目有效资料/约定目录，支持 q/kind/cursor/limit；`POST .../project-materials/preview` 接受最多 16 个 kind/id/revision/contentHash/maxChars，返回有界补充文本、hash、遗漏及遮盖标记，不持久化。`GET /runs/:runId/materials` 返回固定材料与启动事实；`GET /tasks/:taskId/material-bundles/:bundleId` 用父任务/项目的当前权限读取历史快照。

原生/节点 `/runs` 与 `/continuations` 可带 `projectMaterials:{items,expectedHash}` 和 `expectedTaskContextHash`。模拟运行拒绝选材。迁移 15 新增 context_bundles，和 Run/Operation、派发、回执同事务；等待节点 Run 复用 bundle 和完整输入，原生等待在停止后补齐原有代码摘要。版本变化在停止或启动前复核，暂停保留材料和未知锁。只有真实 spawn/running 记录启动，ACK/许可不是 provider receipt。完整契约与预算见 [项目选材](../engineering/project-materials.md)。

## 05-04 实现子集：AI 草稿与局部采用

`GET /tasks/:taskId/messages/:messageId/draft-preview` 读取当前任务 AI 回复的源指纹/节选；`GET/POST /tasks/:taskId/ai-drafts` 列表/保存，`GET/PATCH .../:draftId` 读取/修订。`GET .../:draftId/target?kind=task|source&id=...` 返回有权限目标的当前正文/版本；`POST .../:draftId/adoptions` 接受 expectedRevision、ranges:[{start,end}]、mode:append|replace 与 target:{kind,id,expectedRevision}，实际采用文本由服务端从已保存草稿计算。

迁移 16 新增 ai_drafts、ai_draft_revisions、ai_draft_adoptions。目标、采用前后记录、资料修订、任务待接续暂停、事件及回执同事务。当前权限在读取、写入和旧回执前重查；私有草稿不能借目标参数公开。`GET .../:draftId/revisions` 和 `/adoptions` 提供分页历史。原输出不自动变草稿，采用不启动执行或发布约定；详情见 [用法](../engineering/ai-drafts.md)。

## 真人有限协助切片（11）

迁移 17：assistances / assistance_grants / assistance_replies / assistance_events；outbox 新增 assistance_id。`snapshot_reply` 是限定到单协助固定文本与回复的授权，不用于 Task/Project/目录判权。

新增 `GET /tasks/:taskId/messages/:messageId/assistance-preview`、`GET /tasks/:taskId/assistance-recipients`、`GET/POST /tasks/:taskId/assistances`、`GET /assistances`、`GET /assistances/:id`、`POST /assistances/:id/replies`、`POST /assistances/:id/state`。接收者路由不绕过原 Task 守卫；当前权限和有限授权由 AssistanceStore 独立校验。请求体与分页见 [真人协助 API](../engineering/human-assistance.md)。

## 11-04/05/06 Claude 纯文本 AI 协助实现

迁移 18 在原 assistance_grants 增加 model_text，不改变 snapshot_reply 记录或旧授权。Run 增加可选 purpose=assist 和 assistanceId；Assistance 增加 recipientKind=ai 及固定输入/Run 关联。节点 policy 只有明确 textAssistance:true 才允许该种派发。命令使用独立文本环境 ID 而非项目目录，不能由浏览器填写路径/会话。

新增 `GET /tasks/:id/ai-assistance-options` 和 `POST /tasks/:id/ai-assistances`（201 + AssistanceDetail）。创建严格限定来源哈希/任务修订、单片段、问题、节点/policyHash 与两项同意；事务同时保存授权、辅助 Run、派发、事件及回执。读取和取消复用 Assistance，不能通过真人 replies 接口触发模型。主编程查询排除 assist，完整执行历史保留。协议与剩余边界见 [AI 文本协助](../engineering/ai-text-assistance.md)。


## 普通Task搜索分页

`GET /api/v1/search?q=...&cursor=...` 继续使用现有当前可见Task集合；q按原规则去首尾空白、最多160字符并转小写，匹配标题、说明和编号拼接文本。首批不带cursor，响应为 `{ items: Task[], nextCursor: string | null }`，每批最多30项。cursor最多1024字符，绑定规范化查询和当前有序匹配DTO序列，不是访问凭据或历史快照。非法/不匹配查询返回INVALID_CURSOR/400，当前序列变化返回SEARCH_RESULTS_CHANGED/409；客户端清除旧批次并明确重新搜索。读取不更新业务表，无新增迁移/写操作。


Task搜索的范围扩展：可选`scope=all|personal|project`，缺省all；personal只取当前集合中projectId为null的Task，project必须带非空、无首尾空白、最多150字符的projectId；all/personal不接受projectId。重复/非法/不完整范围返回INVALID_INPUT/400，合法但无匹配ID返回空页，不放大为全局。游标摘要同时绑定规范化q、scope与projectId，范围先于匹配序列摘要和分页；此前只绑定q的旧书签明确INVALID_CURSOR后重搜。未新增权限来源、资源端点或数据库模型。


全局搜索类型扩展：`GET /api/v1/search?type=task|result|agreement`，缺省或显式task沿原Task响应与书签，空/重复/未知类型INVALID_INPUT/400。result复用q/scope/projectId/cursor规则，先关联当前Task再按范围和成果库原独立字段谓词匹配；响应items为当前Result字段加最小task上下文 `{id,title,shortId,projectId}`，nextCursor仍可空。游标包含result类型及当前Result/父Task来源指纹，跨类型400、结果变化409。当前Result只有numeric revision，API不伪造固定版本ID，也不检索旧版本正文。


约定全局查找扩展：agreement类型复用q/scope/projectId/cursor，个人scope明确INVALID_INPUT/400；只读当前可见项目的project_agreements当前行，按全局rowid降序，在匹配与30项分页前取项目范围。标题与content沿原约定拼接文字规则匹配，active/inactive/superseded各当前记录一次；响应明确最小id/projectId/title/content/revision/state/updatedAt与project{id,name,archivedAt?}，不发送origin/来源讨论节选或历史。afterAgreementId书签独立绑定type/query/scope及当前有序DTO，错配400、变化409；原Task/Result书签保持。

Workbench只读响应新增可选projectAgreementVersions数组 `{projectId,version}`，仅对同响应当前可见项目返回既有约定变更版本，不包含正文；没有版本行时的0只用于已经过原项目读取检查的项目。旧/未就绪响应缺字段或缺所选项目元数据不能当作0。普通SSE后的Workbench读取传递变化，新约定搜索按相关项目版本及来源标签取消旧页；该信号按项目粒度，既非查询专属版本，也不保证永远在线同步。无新端点、迁移、身份源或业务写入。


## 14-06 固定版本的手动报告/发布链接

`GET/POST /api/v1/results/:resultId/versions/:revisionId/references`读取或添加当前固定版本有效链接；GET返回`{items,limit:20}`，POST接受`{kind:'report'|'release',title,url,environment?,sourceNote?}`。标题160、HTTP(S)地址2048、环境120、来源说明1000字符；地址不接受内嵌账号密码、空白或控制字符，服务不请求该地址。`POST .../references/:referenceId/remove`接受空对象并返回保留的移除记录。

迁移32新增独立result_references及同Result/Revision外键，旧正文链接不推断为历史引用。记录固定resultId/resultRevisionId/taskId、原文字、`source:'manual'`、`externalState:'unknown'`、`availability:'not_checked'`、真实记录/移除人和时间。有效引用按记录顺序倒序，最多20个；移除保留记录。

两个写命令沿现有Idempotency-Key；作用域按Result/动作固定，指纹包含实际版本ID和原请求对象。现有父Task读/编辑guard在原事务旧回执之前复核；引用/移除、outbox与回执原子提交。不同版本或改包复用键拒绝；同包重放返回原回执，重复移除不再产生事件。结果正文/版本/Task/Run状态不随引用修改。

## 04-03 项目任务的持久排序

`GET /api/v1/projects/:projectId/task-order` 返回 `{projectId,revision,baseline,taskIds}`，只包含原授权集合中的同项目任务，无查询参数。未排序项目沿原 rowid 倒序，虚拟排序 revision=1；读取使用一致 SQLite 快照，不建立排序行。迁移33新增独立 `project_task_order_sets` 与 `project_task_ranks`，不改变 Task JSON/修订。

`POST .../task-order/move` 只接受 `{taskId,anchorTaskId,placement:'before'|'after',expectedRevision,expectedBaseline}`；ID最多150字符且不同，baseline为64位小写十六进制，独立正文预算4096字节。使用原 `Idempotency-Key`；当前项目编辑及所移动Task编辑guard在事务旧回执之前复核，参照Task须当前可读且同项目。新移动不接受cancelled任务。

baseline绑定当前可读有序ID及状态；当前修订或基线变化返回 `PROJECT_TASK_ORDER_CONFLICT/409`。一次移动仅改变指定Task的位置，其余任务相对顺序保持，包括UI筛选隐藏项。稳定整数rank必要时同事务重排间距；实际移动、独立修订、项目outbox和回执原子提交。无变化不增修订、不发事件或建立rank，但保留原回执。

返回 `{projectId,taskId,anchorTaskId,placement,revision,baseline,changed}`，不携带历史可见ID列表。原始解码请求用于幂等指纹；相同包重放确认原回执，不重做移动，改包同键拒绝。普通Task内容变化不会改排序基线；新任务追加在已有rank之后，未排序的新任务彼此仍沿原rowid顺序。协议与UI限制见[项目任务排序](../engineering/project-task-order.md)。

## 2026-10-08：身份、能力与独立只读连接的实际候选子集


新增契约为 AgentParticipant、AgentEndpoint、AgentCapability、DelegationGrant、AgentConnection 及 Listing/Selection/Issue 读取形状；AgentProfile 仍表示执行配置，Task 负责人仍是真人。

迁移 36 承接原迁移 35 的日期功能，增加 agent_participants、agent_endpoints、agent_capabilities、agent_capability_versions、agent_delegation_grants、agent_connections。能力历史不可变；登记/更新/撤销、幂等回执与 outbox 原子提交，当前权限先于旧回执。

本人资源管理仍经真实浏览器身份的 `/api/v1` 通道：

- GET/POST `/api/v1/agent-participants`。
- PATCH `/api/v1/agent-participants/:agentId`；POST 同资源 `/revoke`。
- POST 同资源 `/endpoint`、`/capability`、`/grants`、`/grants/:grantId/revoke`。
- POST 同资源 `/connection`（首次创建或固定修订轮换）、`/connection/revoke`。
- GET `/api/v1/projects/:projectId/agent-capabilities`；POST 同目录 `/:capabilityId/select`，仅复核版本/权限和准备标识，不创建请求或启动执行。

独立 Agent 只读通道只有 GET `/agent/v1/identity` 与 GET `/agent/v1/projects/:projectId/capabilities`。连接为稳定 participant/connection ID、单项目 `capability_read`、最长 24 小时、独立 Bearer 凭据；只存摘要，首次提交响应一次返回 token，旧键重试只返回当前资源元数据与 null token。凭据轮换立即废止旧代；撤销、端点更新、项目归档、所有者项目/空间撤权使旧连接永久失效，重新加入或恢复归档不复活。查询每次重新认证及核对当前权限。

专用通道不接受浏览器 Cookie、Origin、浏览器/节点标记、空间覆盖，不开放 body/query 或 allowlist 外动作。不会把浏览器会话或节点令牌转换成 Agent 身份。当前仍受 preview/team-local 回环边界约束，无外部连接或正式远端部署。

端点只保存 HTTPS 元数据，不拨号或验证远端。首轮能力固定 `text_expertise`、文本输入/输出，提供方支持 `unverified`、HEXU 接收适配 `not_integrated`、环境/授权条件单列，`callable=false`。预授权包含项目/参与者、可发现/可请求、自动接受意向、固定能力版本与端点修订、所有者费用主体、期限与并发；execution/externalEffects 均 false。请求/自动接受只记录后续条件，不已有协商或模型执行。

独立连接凭据只允许上述项目能力读取，不授予请求/执行/材料读取权限。MCP/A2A 桥、双向协商、真实接收、结果消费、跨设备部署及双独立 Agent 闭环仍待后续切片。

实现见[契约](../../packages/contracts/src/agent-capabilities.ts)、[数据事务](../../packages/db/src/agent-capabilities.ts)、[连接认证](../../packages/identity/src/agent-connections.ts)、[资源 HTTP](../../apps/control/src/agent-capabilities.ts)与[独立 HTTP](../../apps/control/src/agent-connections.ts)。检查边界见[本轮记录](history/2026-10-08-agent-capability-entry.md)。

本轮并发1—4、费用主体与autoAccept只保存策略，没有执行器强制并发/费用联调；endpoint.authentication的not_integrated指接收适配，入站capability_read认证不能推导为可调用端点。


## 2026-10-08 切片2：有限材料与类型协商候选

以下是基线37d6095上的实际代码候选，已有本轮分组定向/静态检查；不改25原规划，也不把拟定设计当作已验收API。入口见[契约](../../packages/contracts/src/agent-assistance.ts)、[领域规则](../../packages/domain/src/agent-assistance.ts)、[原Store协商增量](../../packages/db/src/agent-assistance.ts)、[HTTP](../../apps/control/src/agent-assistance.ts)、[有限连接认证](../../packages/identity/src/agent-assistance-connections.ts)。

- 原Assistance增加recipientKind=agent，仍只有open/responded/closed/cancelled四态。awaiting_acceptance/accepted/waiting_input/answered/terminal从当前输入与类型回应推导，不设第二套可写生命周期。
- 迁移37追加assistance_agent_requests、assistance_input_revisions、assistance_input_grants、assistance_agent_capacity、assistance_agent_credentials；原1—36与旧真人/Claude记录保留。输入历史不可变，回应保存inputRevision/inputHash/accessRevision与服务端真实human/agent/policy来源。
- 输入只含固定既有消息摘录和明确选择的项目纯文本source版本；最多16项、每项最多8000字符，附加项目文本合计10000、完整输入20000，HTTP正文64KiB。链接、文件/diff、完整会话与任意URL不作为输入。
- accept、decline、request_input、propose_scope、answer是五种明确类型。scope提案必须保留主消息摘录锚点，只能删去额外项目文本；重述问题须发起者明确确认成新输入，不会自动扩权。材料过期阻断accept/answer；当前请求权限仍有效时可decline或request_input要求更新，不把业务拒绝记成provider失败。
- 自动接受只在当前有限预授权允许时写policy接受事实，按固定grant计容量，尚无投递、执行器、模型或费用动作。补充输入释放旧接受并重新竞争；answer/decline/close/cancel/撤权释放容量。
- 所有写入在事务内先核当前权限再看ID-only回执；输入/授权/容量/回应/事件/outbox/幂等一起提交。旧包同键确认不重复创建，异包拒绝；当前撤权优先于旧回执。

浏览器/真实成员路径：

- POST `/api/v1/tasks/:taskId/agent-assistance-preview`，预览固定材料，不保存。
- POST `/api/v1/tasks/:taskId/agent-assistances`，显式确认分享后保存原Assistance。
- POST `/api/v1/assistances/:assistanceId/responses`、POST同资源`/input-revisions`；GET同资源`/input-revisions/:revision`读取逐版本获授权快照。
- POST同资源`/credentials`、`/credentials/revoke`，显式发行/轮换/撤销请求限定凭据。
- 原协助详情/列表/state路径复用；旧replies与采用路径不把新Agent分支冒充真人或成功Claude assist Run。

独立请求通道仅开放GET `/agent-assistance/v1/identity`、GET `/agent-assistance/v1/requests/:requestId`、GET同请求`/input-revisions/:revision`、POST同请求`/responses`。请求token最多24小时，scopes仅material_read或material_read+respond，凭据仅摘要保存、首次响应返回一次明文；不是原capability_read token，不接受Cookie/Origin/节点/空间/浏览器身份覆盖。身份和请求最小投影不暴露父Task/Project IDs、源ID与所有者principal；外部/不存在requestId给同类opaque404。

正常补充输入不必轮换仍有效的request token，但每次访问重新核对应input grant；旧输入respond被撤销，新输入明确授权，获准历史read继续逐版本判定。轮换/显式撤权、原授权/端点/能力/成员失效会永久终止旧token，重新加入不复活。

本片仍callable=false、0 Run、0模型；没有MCP桥、真实收件进程、events订阅、远端投递或自动结果消费。检查与剩余见[切片2记录](history/2026-10-08-agent-assistance-negotiation.md)。

## 2026-10-08 切片3：有限发起授权与经典stdio MCP

新增单Task、固定选材版本、单目标能力/grant、本人participant的 `AgentRequesterCredential`；迁移38仅追加独立hash-only凭据/失效触发器。最多24小时且不超过目标预授权期限；发行返回明文一次，回执只保存ID。原迁移1—37与capability_read、请求限定material_read/respond不扩权。

所有者的浏览器认证接口：GET/POST `/api/v1/tasks/:taskId/agent-requester-credentials`；POST同资源`/:credentialId/revoke`。发行接受 `{participantId,preview:AgentAssistancePreviewCommand,expectedTaskRevision,expectedInputHash,shareConfirmed:true,expiresAt}`，返回201 `{credential,token}`；同键确认token为null。撤销接受 `{expectedRevision}`、返回 `{credential}`。列表不含密钥或原完整材料。

独立 `/agent-requester/v1` 仅接受新 `hexu_requester_` Bearer、`x-hexu-agent-api:1`，禁止浏览器/节点/空间身份覆盖与query；每次和事务内重验当前授权。固定Task/target从凭据取得，不接受调用方覆盖。明细投影沿用有限请求view，不含父Task/Project/source/owner IDs。

- GET `identity`：实际Agent参与/连接/代次/期限。
- GET `capabilities`：当前固定目标的目录元数据；不是canRequest即授权。
- GET `materials`：固定授权材料 `{materials,question,clarification}`。
- POST `preview`：`{question,clarification,materialIds}`，返回 `{expectedTaskRevision,inputHash,question,clarification,materials}`。message必须保留，其他只可原列表子集。
- POST `requests`：上面输入（首次clarification=null）加 `{expectedTaskRevision,expectedInputHash}`，原Idempotency-Key保存一次Assistance；Agent的分享来自所有者固定预授权，不接受新shareConfirmed自授权限。
- GET `requests`：仅本人participant在固定Task及本授权范围内的请求。GET `requests/:requestId`取得同一业务记录。两者不创建第二inbox或接收者万能凭据。
- POST `requests/:requestId/input-revisions`：输入加 `{expectedRevision,expectedInputRevision,expectedAccessRevision,expectedTaskRevision,causeResponseId,expectedInputHash}`；不可变新输入、原回应不改，材料只能进一步缩小。
- POST `requests/:requestId/cancel`：`{expectedRevision}`。取消分享与后续回应，不是停止外部执行确认。
- GET `receipts/:operationKey`：同connection的原create回执，返回 `{status:'not_recorded'}` 或 `{status:'recorded',request}`；当前权限和固定材料核对优先，不回放新动作。

AgentAssistance原preview/create/revise/change显式接收经认证的requester actor；材料来源与事件保存真正Agent身份/connection revision，回执按connection隔离，不借ownerPrincipal假装真人。原human/Claude路径继续独立。

经典MCP stdio入口 `[apps/mcp/src](../../apps/mcp/src)` 只声明tools；协议 `2025-11-25`，初始化/严格输入/请求角色/帧与响应预算一起校验。工具名字与完整schema唯一实现在 [tools.ts](../../apps/mcp/src/tools.ts)：发起9项，接收4项。操作说明与参数矩阵见[有限MCP入口](../engineering/agent-mcp.md)。桥无业务数据库、无模型/Run、不重试写入、不跟重定向，控制服务回环限制不变。

接收端沿原单请求凭据，仅列表投影这一请求；新求助的权限bootstrap仍需所有者预置，不是自动收件。dot Events所需MCP2.0 `2026-07-28`、远程认证/事件投递与原线程消费均未实现，不把stdio经典握手当作真实dot插件接通。

新preview的项目文本materialId为稳定opaque source摘要（不发送明文sourceId），同源跨子集/顺序/凭据和human/MCP入口保持一致。旧顺序ID输入不改写，历史严格校验沿用存储IDs；新requester访问逐输入核对credential-local映射，不自动接管不兼容旧别名请求。

## 2026-10-08 切片4：原工作绑定与固定回答消费

契约 [agent-consumption.ts](../../packages/contracts/src/agent-consumption.ts)，操作语义见[原工作回接](../engineering/agent-result-consumption.md)。迁移39只有原Assistance附属绑定、一次消费、ACK及独立取消记录，均不可变；不新增Task/Run或第二套成果生命周期。

有限requester通道新增：
- POST `bound-requests`：严格 `{request:AgentRequesterCreate,origin:{provider,threadRef,sessionRef}}`，201 `{request,binding,consumption}`；原请求与绑定同事务。旧`requests`保持兼容。
- POST `requests/:requestId/binding`：`{origin}`，仅原创建Agent/连接、答案前；不可改绑。
- GET `requests/:requestId/consumption`：`{binding,consumption}`，当前权限/材料先核对。
- POST 同请求`consume`：`{responseId,inputRevision,inputHash,accessRevision,bindingId}`，一次claim。
- POST 同请求`ack`：`{consumptionId,bindingId,threadRef,sessionRef,turnRef,output}`，有限后续输出观测。
- POST 同请求`cancel-consumption`：`{bindingId}`，只取消未来回接。

写动作需原Idempotency-Key，返回view加`delivery:first|replay`；replay从不授权重复执行。binding.source=`host_reported`，ACK.evidence=`external_self_report`。短答案以固定Assistance response ID/input版本/hash为成果引用；原Task来自认证凭据，不接受客户端覆盖。bearer来源投影隐藏ownerUserId；不扩大旧capability_read、receiver material_read/respond或浏览器权限。

GET `/api/v1/tasks/:taskId/agent-consumptions` 只给当前父Task读者原回接投影，隐藏原thread/session/credential。原采用接口新增认证external answer来源分支，固定source.external.response，不伪造assist Run。

经典stdio requester现15工具（旧9 + bind/get_consumption/consume_answer/ack_consumption/cancel_consumption/wait_answer），receiver仍4；schema仍唯一在tools.ts。原host环境固定thread/session，工具参数不能提升或改绑。wait最多30秒/每秒一次；读取不启动/唤醒模型。真实模型及跨回合恢复、MCP2 Events尚未接入。

## 切片5：receiver bootstrap、MCP2 Events与有限TLS入口

迁移40增加有限 `agent_receiver_connections`，迁移41增加订阅、验证intent与投递观测表/原outbox原子trigger；不是新Task/Run/Assistance状态。旧1—39保留。owner issuance及有限 REST 详情见[工程说明](../engineering/agent-remote-events.md)。受认证receiver依当前grant派生单请求主体；token只hash，最长24小时；失权/降权永久吊销，不因重新加入复活。

`POST /collaboration/mcp` 是独立MCP2 `2026-07-28`，不是旧stdio握手。提供server/discover、tools/list/call、events/list/subscribe/unsubscribe；工具4项复用receiver原业务。`hexu.assistance.changed`的input为空object，payload仅requestId，无replay cursor。订阅/回调验证、加密静态secret、轮换、同ID bounded retry与当前权限再验在[实现](../../apps/control/src/agent-events.ts)及[安全发送](../../apps/control/src/event-webhook.ts)。传输accepted不改Assistance业务完成。

独立TLS应用只允许上述MCP及requester/receiver有限REST，拒绝human API、原生/runner、旧request-token远程receiver及不匹配Host/forwarded/browser headers。原createApp仍loopback。真实插件OAuth/账号连接、HTTPS部署及跨成员模型闭环未验；不要把协议fixture视为这些能力已完成。
