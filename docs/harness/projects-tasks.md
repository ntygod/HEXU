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

## Task 工作说明与创建预算

工作说明只改标题、说明和关注事项，不建立内容历史、独立需求或执行输入。编辑固定 Task、原修订和原文；SSE 只展示冲突，载入新基线须明确选择。未知 PATCH 只确认原正文/键，关闭后的迟到结果不能清除后来编辑器或草稿。当前访问/编辑权丢失清除详情与原包，重授不复活；暂时读取故障与明确拒绝分开。

Task PATCH 在事务内读取旧回执前核对当前编辑权；普通 `beforeReplay` 回调只提供该最小依赖，不因此导入其他成果功能或迁移。普通创建 POST 与 PATCH 独立使用 96 KiB JSON 预算，以容纳原字符上限和 JSON 转义；不得提升全局/无关路由预算或扩充可写字段。创建事务开始后、返回旧回执前也须先核对 team 当前空间权限，再检查非空项目的编辑权；私有创建/回放也须受空间撤权约束。以独立 SQLite 连接的项目/空间权限变化分别覆盖这项时序。当前用法见[工作说明编辑](../engineering/task-edit-baseline.md)。

## Task 完成、取消、重开与未知结果

状态命令在事务开始后、读取 complete/cancel/reopen 旧回执前重新核对当前 Task 编辑权；使用真实第二 SQLite 连接覆盖事务开始前权限变化，不把 UI 权限检查代替该回归。本轮只明确普通创建、PATCH 与状态命令的授权时序，不据此声称全系统回执均已覆盖。

完成/取消确认跟随当前父 Task 可见性与编辑权，失效时清除旧标题/选择/原包。尚未发送时固定修订，变化须重新确认；已发送包不因自身 SSE 或后来修订而重设。取消从同 Task 全部 `isActiveRun` 判断 stop/keep，不能只看主编程执行；无活动时固定 keep，发送前新活动需重新确认。停止请求不是终止证据，不清未知锁。

首次发送固定 Task、动作、正文和幂等键。未知结果只显式确认原包，关闭后同 Task 的其他状态入口先恢复它；当前撤权、身份/空间变更清除已关闭的包，不跨硬刷新。有效成功 ACK 后 Workbench 失败只能 GET 刷新，不重发业务写入。旧 POST、拒绝、finally 及所属刷新均按确认会话隔离；不更改原全局身份失效语义，也不声称读取回执会跳过整个控制路由。

详情取消保留讨论/成果，已取消 Task 的详情/固定成果使用原重开动作，不能把成果版本、Task 状态和 Run 终止混成一项事实。完成无需报告；不新增完成历史 API、取消原因、数据库模型或后端回执协议。用法见[状态确认](../engineering/task-completion-confirmation.md)。

## 如何验证与回写

普通 Task 修正复用[编辑](../../tests/task-edit-baseline.test.ts)、[创建预算](../../tests/task-create-budget.test.ts)、[状态原回执](../../tests/task-status-replay.test.ts)与对应浏览器流程；未知 POST、已接受后 GET 故障、关闭/导航/重复点击、当前撤权和迟到回应用真实请求边界区分。

对应复用 [项目设置](../../tests/project-settings.test.ts)、[归档](../../tests/project-archive.test.ts)、[改派](../../tests/task-assignment.test.ts)、[参与](../../tests/task-participants.test.ts) 及 [团队 UI](../../tests/e2e/team.spec.ts)。涉及事务时核对旧回执、修订冲突和回滚；改展示不必重新验证全部执行协议。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

访问策略变化读 [身份](identity.md)；归档/改派影响等待安排时读 [接续](continuation.md)；抽屉交互读 [UI](ui.md)。
