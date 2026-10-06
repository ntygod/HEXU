# 项目与任务协作 harness

> 按需读取：修改项目设置/归档、Task 创建/工作说明/状态确认、任务改派、参与者或人员筛选。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[03 项目](../development/03-identity-projects.md)、[04 任务](../development/04-tasks-requirements.md)。
- 按改动选择：[设置事务](../../packages/db/src/project-settings.ts)、[归档事务](../../packages/db/src/project-lifecycle.ts)、[改派](../../packages/db/src/task-assignment.ts)、[参与](../../packages/db/src/task-participants.ts)、[人员筛选](../../apps/web/src/project-task-filters.tsx)。只读本次相关小节。

## 项目基本信息

Project metadata edits require current project manage permission before replay and inside the transaction. Strictly accept name/description/expectedRevision; never persist request-scoped access or memberIds. The project update, immutable revision snapshot, project-scoped outbox event and idempotent receipt commit together. Old database migration records only the known snapshot with unknown author/time, not invented history. History and SSE use the parent's current access rules.

Keep the edit baseline fixed while the drawer is open. SSE updates show a comparison without replacing the draft or silently rebasing. Uncertain replies reuse the exact original payload/key when the user confirms; never infer that closing a drawer cancels a sent request. Drafts are drawer-local memory, cleared on close/refresh/identity or space changes and revoked manage access. Project edits do not update tasks, nodes, frozen material or running models. Archive/restore uses the separate lifecycle endpoint and the same project revision, never metadata PATCH.

## 项目归档与恢复

Archive is a barrier for new model work, not deletion or a blanket read-only state for human collaboration. Require current project manage permission before replay and inside the revision-checked transaction. Commit project state/history/outbox, cancellation of never-permitted node dispatches and suspension of every pending preview/node Operation together. Preserve fixed Operation material; immediate restore never revives old plans. Only unpermitted cancellation returns selected notes to queued.

Explicit keep/stop applies to already-permitted/started runs. Stop only runs in tasks the caller can currently edit; activity summaries must not reveal private tasks. Unknown/permitted writers retain claims and require actual termination evidence. Preparing preview execution is invalidated durably; also check after async directory preparation and immediately before Codex spawn. Revalidate project state at direct Run creation, idempotent replay, node permit and final continuation commit. Restore must not replay work, reissue permits, revive revoked node credentials, or clear writer locks.

Keep archive controls in the W1 project-settings drawer with explicit impact/stop choice and same-request receipt recovery. Archived tasks keep discussion/results/manual status and stop actions; disable and close execution/resume/reconfigure panels after the project-scoped SSE update. Project list filtering must not hide ongoing runs from task/workbench views. Do not reinterpret archive as OS process termination or as a new remote-deployment feature.

## 真人负责人改派

Project-visible task assignment is a separate semantic command, never a generic PATCH or implicit sharing path. Revalidate task edit access before idempotent replay and in the transaction; the target must be a current space/project edit/manage member. Assignment is responsibility, not an access grant or node/credential/history transfer. Preserve new Task/Run createdByUserId separately from ownerUserId; leave legacy identity unknown, never infer it from the current owner.

Commit Task revision, immutable assignment event, pending preview/node Operation suspension, scoped outbox and receipt atomically. Preserve frozen material, existing Run/dispatch identity and unknown workspace claims. Do not stop active runs, send live input, issue a permit or spawn paid work from assignment. Unpermitted old dispatches remain subject to task revision checks; keep their original command, do not silently rebase. Archived projects still allow this human-only collaboration. Old receipts must not repeat any side effect.

The task-assignment feature owns its W1 drawer/styles. Fix the edit baseline; SSE can flag changed tasks or invalid candidates but cannot replace a selection or implicitly raise expectedRevision. Uncertain results retry the identical payload/key only on explicit confirmation. Close/refresh/identity-space changes or revoked edit permission discard local editor state. Display unavailable owners honestly from current membership or recorded task-scoped history, never query unrelated private people as an assignment candidate. Follow 22 for the next slice, not another task/session system.

## 参与关系与人员筛选

Participants are collaboration metadata, never access grants. Current project viewers may join/leave themselves; managing other people requires task edit access. Recheck parent access before receipt replay and in the transaction. Restrict candidates to current same-space project members, reject private-task sharing, and preserve archived-project human collaboration. The identity write-guard exception is only self participation on its exact semantic route, never other task writes.

Use the independent participation revision, immutable events, scoped outbox and idempotent receipt in one transaction. Project/space revocation ends active relations in the same membership transaction; rejoining or replaying an old receipt cannot reactivate them. Leaving participation does not revoke existing project access. Preserve recorded task-scoped names without looking up outsiders.

Participation is excluded from model materials: do not update Task revision/timestamps, owner, Run, dispatch, frozen Operation or workspace locks. Actual access revocation still uses existing execution/continuation checks. participantUserIds is only a read projection, never persisted Task JSON or model input. Keep one pure people/search predicate for API and board/list, filter after current access checks, and preserve URL selection across reload/back. Uncertain UI changes confirm the same payload/key; authority changes discard the drawer. Follow 22 for the next slice; complete sorting, status/label/attention filters and private sharing remain pending.

## 项目任务状态导航

状态是当前可见项目投影上的 UI 选择，保留既有人员/关键词 API 与纯谓词。默认排除 cancelled；合法状态选择保存于 URL，列表/看板取相同交集。无效、空白或重复状态不得静默扩大结果，须显示错误并允许清除。取消列只读，导航到现有 Task 详情，不通过筛选触发状态命令或执行。项目总览/成果的原数据范围不随本次选择改变。当前边界与用法见[参与者说明](../engineering/task-participants.md#项目任务状态选择)。

## 项目关注内容查找

关注筛选只判断已可见 Task.attention 去空白后是否有文本；null/空/纯空白均未填写，不从自由文本推断 waiting/blocked/paused 或 Run 状态。默认不加此条件，present/absent 与状态/人员/关键词取交集。URL 非法/重复/空值须明确报错且零结果；切换视图、刷新、历史与清除保留既有导航。它没有 API、权限、数据库或状态命令改动，取消列只读及项目总览/成果原范围保持。

## 项目说明关键词命中片段

片段只解释当前可见 Task 已有关键词命中，不修改共享筛选谓词、结果集合/排序或 URL。标题/编号已命中、空查询或说明无命中时保留原显示；说明首处独立命中才展示有界上下文。React 文本/mark 渲染，不插入 HTML；Unicode 截取、高亮和省略须依据原文，不把大小写转换后的偏移直接当原字符串偏移。列表保留 attention/项目元数据，看板的片段不再被开头三行裁掉关键命中。取消列只读及原任务导航保持。

## Task 工作说明与创建预算

工作说明只改标题、说明和关注事项，不建立内容历史、独立需求或执行输入。编辑固定 Task、原修订和原文；SSE 只展示冲突，载入新基线须明确选择。未知 PATCH 只确认原正文/键，关闭后的迟到结果不能清除后来编辑器或草稿。当前访问/编辑权丢失清除详情与原包，重授不复活；暂时读取故障与明确拒绝分开。

Task PATCH 在事务内读取旧回执前核对当前编辑权；普通 `beforeReplay` 回调只提供该最小依赖，不因此导入其他成果功能或迁移。普通创建 POST 与 PATCH 独立使用 96 KiB JSON 预算，以容纳原字符上限和 JSON 转义；不得提升全局/无关路由预算或扩充可写字段。创建事务开始后、返回旧回执前也须先核对 team 当前空间权限，再检查非空项目的编辑权；私有创建/回放也须受空间撤权约束。以独立 SQLite 连接的项目/空间权限变化分别覆盖这项时序。当前用法见[工作说明编辑](../engineering/task-edit-baseline.md)。

## 普通 Task 创建的原请求恢复

普通创建首次 POST 前固定标题、说明、项目、空间、路径和幂等键；重试不是新建另一项 Task。当前身份/空间的未结创建包由既有 Provider 内存拥有，所有 NewTask 入口先恢复它；关闭或导航不撤回可能已提交的操作，不能以改表单/项目、重开入口或重复点击换键绕过。未发送草稿在新建表单本地、关闭即丢弃；已提交原包留在 Provider 中，二者均不跨硬刷新。

未知结果只显式确认完全相同的原正文/键，不能把当前 Workbench/SSE 投影当作该请求成功回执。核对有效创建 ACK 的身份/空间/项目、内容和初始 Task 状态后先记住已接受结果；核对内容使用现有契约规范化，重试正文保持原样。后续 GET 失败只能刷新读取，不重发 POST。旧 POST、拒绝、finally 与所属刷新按 UI 会话隔离，不清空后来草稿、不关闭新界面、不抢回导航。

当前项目创建权限失效、身份或空间变更清除原包与不再可见的内容，重新授权不复活；短暂读取故障不等于撤权。自己的明确访问拒绝清除仍属原请求的包；其他明确 4xx 恢复可编辑原输入，网络/5xx/无效 ACK 保留未知原包。普通创建后端的现有当前空间/项目权限与幂等事务保持，不新增可写字段、schema、协议或 Run。当前切片与验收状态见[创建恢复](../engineering/task-creation-request-recovery.md)及[21](../development/21-implementation-status.md)。

创建请求可通过 client 的 `shouldNotifyAccessLoss` 守卫全局身份/空间撤权事件，默认其他请求及 ApiError 不变。不能仅靠弹窗或原包仍存在判断当前身份拒绝：同 Provider 的真实拒绝在关闭/清包后仍须正常广播；旧 Provider、身份、空间或请求空间失配的迟到拒绝不能清空新身份。创建所属 GET 还须服从后来的成功读取快照，拒绝通知与 UI 会话/原包归属分别检查。

## Task 完成、取消、重开与未知结果

状态命令在事务开始后、读取 complete/cancel/reopen 旧回执前重新核对当前 Task 编辑权；使用真实第二 SQLite 连接覆盖事务开始前权限变化，不把 UI 权限检查代替该回归。本轮只明确普通创建、PATCH 与状态命令的授权时序，不据此声称全系统回执均已覆盖。

完成/取消确认跟随当前父 Task 可见性与编辑权，失效时清除旧标题/选择/原包。尚未发送时固定修订，变化须重新确认；已发送包不因自身 SSE 或后来修订而重设。取消从同 Task 全部 `isActiveRun` 判断 stop/keep，不能只看主编程执行；无活动时固定 keep，发送前新活动需重新确认。停止请求不是终止证据，不清未知锁。

直接 start/reopen/无活动 complete 首次点击仍立即 POST，不增加新的事前同意步骤；start 只改变 Task 为 in_progress，不能启动 Run。它们与已有完成/取消确认复用 Provider 原包和 outcome。首次发送前固定 Task、动作、正文、修订和幂等键，保持直接路径原 activeRunAction: stop 正文；只有未知结果或有效 ACK 后 GET 失败才显示直接恢复界面。未知结果只显式确认原包，关闭后同 Task 的其他状态入口先恢复它；当前撤权、身份/空间变更清除已关闭的包，不跨硬刷新。有效成功 ACK 后 Workbench 失败只能 GET 刷新，不重发业务写入。直接发送期间 pathname/search 路由变化分离旧 UI/所属读取，保留原包；仅 hash 锚点不当作离开页面。原包的进行中标记阻止同 Task 重复请求；另一 Task 会话打开后，旧有效 ACK 只可更新仍属自己的原包，不能触发新会话的刷新/UI。旧 POST、拒绝、finally 及所属刷新均按确认会话隔离；不更改原全局身份失效语义，也不声称读取回执会跳过整个控制路由。

详情取消保留讨论/成果，已取消 Task 的详情/固定成果使用原重开动作，不能把成果版本、Task 状态和 Run 终止混成一项事实。完成无需报告；不新增完成历史 API、取消原因、数据库模型或后端回执协议。用法见[状态确认](../engineering/task-completion-confirmation.md)。

## 工作台当前任务展开

工作台任务列表只对当前可见投影逐批呈现，默认8项、每次追加8项；不保存Task副本，不另建查询或权限规则。保留原mine/team、cancelled与活动/未知Run过滤及顺序，继续卡、关注和成果不受展开影响。列表计数来自当前props，页签切换重置展开数；展开焦点进入第一条新任务，收起焦点回到保留的标题。用法见[工作台任务列表](../engineering/workbench-task-list.md)。

## 我参与的工作台入口

参与页签只匹配当前可见Task投影中明确的本人participantUserIds；负责人、消息作者和他人参与均不补造关系。保留原mine/team、cancelled活动例外和顺序，继续卡/关注/成果采用同一选定集合。无当前可继续项与无参与任务分别说明；页签切换复用首批重置，不新增查询、业务写入或持久偏好。用法见[我参与的任务](../engineering/workbench-participating.md)。

## 工作台包括已取消任务

原负责/参与/团队范围先于最近列表选择；默认保持现有取消活动/未知执行例外，显式勾选才展示该范围全部当前可见Task。不可把取消行追加在末尾破坏原顺序，或将该选择用于继续卡、关注、成果和活动计数。切选项重置批次并清理展开焦点意图，焦点留在保留的checkbox；切页签沿原key重置未勾选和首批。零项、只有隐藏取消项与没有可继续参与任务分别说明，不改原Task链接/状态命令。用法见[取消任务浏览](../engineering/workbench-cancelled-tasks.md)。

## 普通Task搜索分页

搜索先取得原Store.tasks当前可见集合，再使用共享原字段matcher；不改rowid顺序或借DTO时间字段重排。30项游标绑定规范化查询与完整当前匹配DTO序列；序列变化使游标失效，不拼接不同版本页。前端只用当前data.tasks的同matcher投影失效旧查询会话，不新增身份源或修改共享client。普通查询/关闭/追加响应按会话取消，追加5xx可原cursor重试，400/409清除旧批次并明确重搜。范围只在原当前集合内按projectId或null交集，先于摘要和分页，游标也绑定scope/projectId；当前项目选项失效不静默变为全局。来源/Task修订用现有当前DTO，说明片段只解释独立命中，不改变原全局跨字段谓词。真实HTTP多页和只读检查见[分页用法](../engineering/task-search-pagination.md)。

## 成员当前工作浏览

成员入口只投影当前Workbench成员与可见Task，原顺序按负责人/明确参与取并集，同Task一次且关系可同时展示。缺参与字段不补造关系，缺成员不回退本人，缺非空项目不解释为个人。数量标明当前已加载可见，不作成员绩效或完整工作量；Task关联Run不证明成员是执行者，未知仍未知。沿原Task导航，页面本身没有新查询/写命令、身份源或状态推断。用法见[成员工作](../engineering/member-work-view.md)。

## 如何验证与回写

普通 Task 修正复用[编辑](../../tests/task-edit-baseline.test.ts)、[创建预算](../../tests/task-create-budget.test.ts)、[状态原回执](../../tests/task-status-replay.test.ts)与对应浏览器流程，直接路径见[直接状态恢复](../../tests/e2e/direct-task-status-recovery.spec.ts)；直接 start/reopen/无活动 complete 的请求未到服务、提交后回包丢失与已接受后 GET 故障分别验证；关闭/导航/重复点击、后来标题/修订、当前撤权和迟到回应用真实请求边界区分。普通创建浏览器入口见[创建恢复](../../tests/e2e/task-creation-request-recovery.spec.ts)，另区分未达服务、已提交回包丢失和有效 ACK 后 GET 故障；核对原键/原正文、唯一 Task/回执/编号/outbox 效果、所有新建入口恢复、权限清理及迟到回应。源函数/HTTP 诊断只证明该诊断的请求与事务行为，不能替代 React/浏览器流程。

对应复用 [项目设置](../../tests/project-settings.test.ts)、[归档](../../tests/project-archive.test.ts)、[改派](../../tests/task-assignment.test.ts)、[参与](../../tests/task-participants.test.ts) 及 [团队 UI](../../tests/e2e/team.spec.ts)。涉及事务时核对旧回执、修订冲突和回滚；改展示不必重新验证全部执行协议。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

访问策略变化读 [身份](identity.md)；归档/改派影响等待安排时读 [接续](continuation.md)；抽屉交互读 [UI](ui.md)。

## 项目任务持久排序

排序是独立项目规划元数据，不写Task内容/状态/修订或Run，不改变全局Store.tasks、工作台或搜索顺序。未排序时沿原序；读取从既有授权集合生成，排序/修订/集合须来自同一SQLite读快照。移动固定原排序revision及有序ID/状态基线，当前项目和所移动Task编辑guard在事务旧回执之前复核；参照项当前同项目可读，取消任务不接受新移动。

一次只移动一个Task相对于明确参照项，其他任务彼此相对顺序保持；rank间距耗尽的重排也必须同事务。移动、独立修订、项目outbox与原回执原子提交，无变化不增修订或事件；ACK不返回历史可见列表。菜单/拖动不隐式rebase，真实409后先读取再明确新选择；普通未知结果只确认原键原包，有效ACK后只GET。关闭同项目控制可恢复原包，跨项目/硬刷新内存包不保留，普通迟到响应不得改写新交互。

列表与看板共享顺序并保留筛选，看板只同列拖动、取消列只读。普通后台读取失败保留同集合最后读取顺序和菜单选择，暂停移动；重读不能改菜单原基线。用法、API与普通测试入口见[项目任务排序](../engineering/project-task-order.md)，不为此修改共享身份client或新增认证诊断。
