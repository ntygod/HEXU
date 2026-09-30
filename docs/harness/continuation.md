# 接续、下一轮要求与 Operation harness

> 按需读取：修改直接继续、wait/request_stop、下一轮要求、预约、取消或重启对账。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[11 工作包](../development/11-continuation-assistance.md)；使用：[节点接续](../engineering/node-continuation.md)、[preview 原生执行](../engineering/native-execution.md)。
- 代码：[原生 Operation 事务](../../packages/db/src/continuations.ts)、[原生协调器](../../apps/runner/src/continuations.ts)、[节点 Operation](../../packages/db/src/node-continuations.ts)、[下一轮要求](../../packages/db/src/next-inputs.ts)。

## 通用持久安排

ContinuationOperation is distinct from both Task and Run. Its succeeded state means a Run was committed, not successful model work. Keep pending task/working-copy reservations and check them in every start route. Commit the Run, working-copy lock, idempotency result and operation link atomically before spawning. Recheck cancellation and human context immediately before commit. A stop request is not termination confirmation. On restart keep unknown process locks and mark pending operations needs_attention; never automatically replay paid execution. Preserve every original work-item ID and maintain the state/evidence/remaining columns in docs/development/19-work-items.md.

## 下一轮要求与直接节点继续

Next-round inputs are task-visible notes, never live model input or automatic dispatch. Only authors with current edit permission may alter queued notes. Selection revisions, source ownership/latest/confirmed stop, exact node/directory and material hash are checked inside Run creation. Bind notes and previousRunId in the same transaction as dispatch/idempotency. Mark started only on actual spawn; never claim provider receipt. Only clearly never-permitted cancellation can return notes to queued; ambiguous permitted launches retain bindings. New notes must not mutate or invalidate an already queued command.

The direct node /runs continuation remains 201+Run for compatibility. E2b4 UI uses the canonical 202 Operation route for fixed-material waiting. Adopt only source-dispatch output up to its first terminal event, with bounded final result/excerpts and chosen notes; no hidden-session migration. Keep next-round creation/reads/mutations under task permissions before idempotent replay. pending-executions exposes only local IDs/phases/counts, never prompts/keys and never changes locks.

## 固定材料的节点等待安排

The node Operation freezes exactly the displayed material, selected note revisions and local policy. Do not silently append output produced after authorization. Actual files remain in the same authorized directory; this is not a checkpoint or native resume. Enforce pending task/node reservations in every start transaction, and recheck the owner's current permissions, source, note revisions, task/human context and policy before stopping or creating a Run. Only the source's automatic todo-to-in_progress transition may account for one expected revision increment.

Commit Run, dispatch, note binding, source link, Operation link, idempotency and outbox atomically. Cancellation does not retract an old stop signal; Operation success means Run creation only. Restart/expiry/context or policy changes pause plans and preserve material; never clear an unknown writer or retry paid work. Project editors may cancel pending plans, but only the node owner may schedule. Legacy preview records remain readable under parent-task permissions.

## 如何验证与回写

方案Run另按[并行 harness](parallel.md#从所选版本继续)固定ResultRevision、选择修订与已记录代码；仍调用201+Run路径，没有伪装成普通202等待Operation。仅确认终止后、原本人同目录、匹配所选提交的新会话。选择后不自动派发；等待/原生恢复/脏现场仍是未交付范围。

复用 [原生接续](../../tests/continuations.test.ts)、[节点派发/接续](../../tests/node-execution.test.ts)、[材料快照](../../tests/project-materials.test.ts) 及相关浏览器流程。重点验证固定输入、源 Run、取消与最后提交之间的竞态；不能把暂停改成自动重放。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

执行证据/锁读 [执行](execution.md)，节点许可读 [节点](nodes.md)，保留会话读 [提供方路由](providers.md)。Operation 等待与原生 resume 不是同一协议。
