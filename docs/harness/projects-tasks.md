# 项目与任务协作 harness

> 按需读取：修改项目设置/归档、任务改派、参与者或人员筛选。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[03 项目](../development/03-identity-projects.md)、[04 任务](../development/04-tasks-requirements.md)。
- 按改动选择：[设置事务](../../packages/db/src/project-settings.ts)、[归档事务](../../packages/db/src/project-lifecycle.ts)、[改派](../../packages/db/src/task-assignment.ts)、[参与](../../packages/db/src/task-participants.ts)、[人员筛选](../../apps/web/src/project-task-filters.tsx)。只读本次相关小节。

## 项目基本信息

Project metadata edits require current project manage permission before replay and inside the transaction. Strictly accept name/description/expectedRevision; never persist request-scoped access or memberIds. The project update, immutable revision snapshot, project-scoped outbox event and idempotent receipt commit together. Old database migration records only the known snapshot with unknown author/time, not invented history. History and SSE use the parent's current access rules.

Keep the edit baseline fixed while the drawer is open. SSE updates show a comparison without replacing the draft or silently rebasing. Uncertain replies reuse the exact original payload/key when the user confirms; never infer that closing a drawer cancels a sent request. Drafts are drawer-local memory, cleared on close/refresh/identity or space changes and revoked manage access. Project edits do not update tasks, nodes, frozen material or running models. Archive/restore uses the separate lifecycle endpoint and the same project revision, never metadata PATCH.

## Task 创建输入

普通Task创建只接受标题、说明和可选项目ID；attention、状态、负责人和执行字段不借大请求体进入创建。标题/说明/项目ID仍按原UTF-16字符上限校验，路由字节预算只为合法Unicode/JSON转义提供有界空间，不提高全局Fastify预算。当前身份/项目权限和原Task插入事务不变。验证[原始与全转义正文、权限及字节边界](../../tests/task-create-budget.test.ts)，并保留无关路由较小限制的回归。

## Task 工作说明编辑

标题/说明/关注内容仍走原Task PATCH，不混入完成、归属或执行命令。编辑基线固定Task ID、修订和原内容；SSE冲突只提示，由用户明确丢弃或保留草稿后采用当前基线。未知保存只确认原正文和幂等键，原回执不可换成最新Task投影；已关闭编辑器的晚响应不能影响新会话。当前Workbench移除Task或详情明确拒绝时清除旧详情/编辑包，不能因临时读取保留而延长撤权内容可见性。事务内当前编辑权限先于回执回放，业务/outbox/回执原子提交。见[操作边界](../engineering/task-edit-baseline.md)与[回归](../../tests/task-edit-baseline.test.ts)。

## Task 工作说明历史

标题/说明/关注内容的历史属于原Task，按当前父Task阅读权限读取，不按历史作者、负责人、协助快照或游标授权。内容快照与创建/PATCH/原采用/清除attention的状态事务、outbox和原回执一起提交；仅实际内容变化留记录，Task修订仍可能因其他操作有间隔。迁移只留已知当前快照且作者/时间未知。不可变表不接受更新或删除，历史读取不能产生执行或修改源材料。

历史抽屉只读：有新内容时提示并保留已读页/展开状态，明确刷新才替换；当前拒绝或工作台移除Task时清空，关闭与身份/空间/Task切换取消旧请求，迟到成功或拒绝均不能影响新会话。分页绑定同一Task已有修订且SQL有界，不把旧权限延长为读取权。见[操作方法](../engineering/task-content-history.md)、[事务/API回归](../../tests/task-content-history.test.ts)与[浏览器流程](../../tests/e2e/task-content-history.spec.ts)。

两版对照只使用当前已读的同Task快照，双方固定且要求较早/较新修订顺序；分页、SSE和明确重读不得静默切换所选版本或正在显示的对照。当前拒绝同样卸载选择与全文，不另建历史权限或恢复操作。复用有界纯文本比较，超字符/行数/计算预算回退两版全文，不能称可应用补丁；legacy来源/作者/时间未知保持。见[只读对照](../engineering/task-content-comparison.md)与[定向语义测试](../../tests/task-content-comparison.test.ts)。

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

## 项目状态与关注筛选

状态过滤使用原Task四状态；关注过滤只看attention去空白后的实际内容，不推断等待/阻塞/暂停或Run生命周期。API未指定status保持全部当前可见状态，项目页面未指定保持排除cancelled；只有明确cancelled才显示只读取消列，不复用三状态下拉隐式重开。所有条件与当前参与关系、负责人和原搜索交集，先权限/项目/当前参与，再过滤和游标。URL不可信输入需校验未知、重复、非法条件，错误不可静默扩大结果；清除保留合法视图及其他项目定位。局部筛选不改全局Workbench、总览计数、状态或执行。见[当前用法](../engineering/task-state-filters.md)。

## Task 标签

标签是项目可见Task自有的有界文字集合，不是项目目录或访问授权。独立标签修订/不可变事件/Task范围outbox/回执同事务；当前父Task权限在旧回执前和事务内复核。无变化不增加修订，旧Task不补造标签历史。只投影人工Workbench/detail/list；不把标签写入原Task JSON、内容修订、运行材料或model输入。

编辑器固定基线，冲突后明确选择载入或整体替换；未知只确认原包键。暂时故障保留草稿，当前拒绝/关闭/身份空间Task改变清理，所有旧读取与晚写回不得影响新会话。筛选按精确规范名称与原条件交集，先当前权限后过滤再分页；URL非法条件不能静默扩大结果。取消看板只读，Task详情仍沿用原人工元数据编辑权。见[用法](../engineering/task-labels.md)与[事务回归](../../tests/task-labels.test.ts)。

## Task 完成记录

现有完成确认必须跟随当前Workbench的父Task可见性与编辑权，失效时清除旧标题/确认，重新授权不自动恢复。原Task修订固定，发送前发现变化需明确重新确认；已发送操作的自身SSE与最终回执分开，旧success/catch/finally不得影响新UI会话。关闭不等于撤回服务器操作，Run停止请求不当作终止事实。见[当前确认边界](../engineering/task-completion-confirmation.md)。

Task详情取消入口只调用原cancel，保留内容/成果及明确重开，不把取消列变为可写。取消总有一次确认；有活动执行时明确stop/keep，读取当前Workbench同Task全部isActiveRun记录而非主编程子集。无活动时固定keep，观察到新活动要重新确认，不能暗改成stop。共用确认会话在完成/取消之间也隔离晚回应及其Workbench读取，不新建API、原因字段或回执模型。见[取消流程](../../tests/e2e/task-cancellation.spec.ts)。

完成记录只读原completion_events，当前父Task权限先于参数/同Task游标查询，SQL有界且按任务修订/事件ID稳定排列。读取时当前可见成员名不当历史名字；未知成员/动作和没有旧记录需诚实显示，不根据Task状态补造历史。查询索引迁移不改变事件模型、Task或Run。查看完成记录不表示执行已停止或代码已发布。

新事件提示保留已读内容，明确刷新才替换；当前拒绝清除，旧分页/权限探测不能覆盖较新的显式读取，关闭与身份/空间/Task变化隔离迟到回应。见[当前用法](../engineering/task-completion-history.md)与[只读回归](../../tests/task-completion-history.test.ts)。

## 如何验证与回写

对应复用 [项目设置](../../tests/project-settings.test.ts)、[归档](../../tests/project-archive.test.ts)、[改派](../../tests/task-assignment.test.ts)、[参与](../../tests/task-participants.test.ts) 及 [团队 UI](../../tests/e2e/team.spec.ts)。涉及事务时核对旧回执、修订冲突和回滚；改展示不必重新验证全部执行协议。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

访问策略变化读 [身份](identity.md)；归档/改派影响等待安排时读 [接续](continuation.md)；抽屉交互读 [UI](ui.md)。
