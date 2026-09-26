# 18｜公共数据、API 与事件目录

> D1 · 跨工作包契约草案，不是已上线 API。  
> [计划入口](README.md) · [工程基础](01-foundation-contracts.md) · [产品领域规则](../product/05-domain-and-state.md)

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
