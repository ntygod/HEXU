# Task 状态的当前权限和原请求恢复

> 本页区分已验收、未合并的 PR56 与其直接状态恢复后续。后续的新代码验证状态见 [21](../development/21-implementation-status.md)；父 PR 的通过不覆盖本次新改动，也不表示已合并 main。

有活动 Run 时，“标记完成”使用原确认弹窗，默认请求同时停止，也可明确只改变 Task 状态。Task 详情的“取消任务…”始终打开一次确认；当前可编辑的 todo、in_progress、done 可取消，已取消 Task 提供“重新打开”。详情和固定成果的重开保留原成果版本；成果页不增加取消入口。归档项目仍允许原人工状态操作。完成不要求报告，讨论/成果保留，取消不代表删除。

取消确认读取当前 Workbench 同 Task 的全部活动 Run，包含普通、方案和 AI 协助，以及 stopping/unknown。已有活动时默认 stop，可明确改为 keep；打开时无活动则固定 keep，提交前观察到新活动需重新确认。原请求处理当次实际提交时的活动执行，不冻结 Run ID，也不表示进程已经终止；未知写入不清锁。

每次打开固定当时 Task、修订和选择。尚未发送时，当前修订变化阻止确认，须重新查看；不静默用新版修订提交。当前 Task 不可见、失去编辑权或当前请求明确拒绝访问时，清除旧标题/选择及原包；重新授权只恢复入口。全局 401/空间撤权仍沿原身份处理。

项目看板状态选择“进行中”会直接 start，“待处理”会直接 reopen；任务详情/固定成果的“重新打开”同样直接 reopen。当前没有活动 Run 时，看板“已完成”和详情/固定成果“标记完成”直接 complete。这些首次操作仍立即发送原 POST，不新增发送前确认。start/reopen 只改变 Task 状态；start 表示 Task 进入 in_progress，绝不表示启动 Run。三项保留原 `expectedRevision` 与 `activeRunAction: stop` 请求正文，无活动完成仍由原路由处理实际提交时的活动执行；请求停止不等于已终止。本次将这三条直接路径接入同一原包恢复，只有未知结果或有效 ACK 后读取失败才打开恢复界面，界面不新增停止选择。

首次发送前固定 Task、动作、正文、原修订和幂等键。网络失败、5xx 或无法核对的成功回执属于未知结果，原处理方式或已确认的停止选择锁定；“确认原请求结果”只重发原包。后来修订或活动变化不把它改成新请求。旧成功/拒绝/finally 及其 Workbench 读取只影响所属 UI 会话，不关闭新弹窗，也不改写新选择或忙碌状态；完成和取消之间同样隔离。

“暂时关闭”只收起已发送请求。在当前账号/空间页面内，再操作同 Task 的状态入口，先恢复待确认原包。直接首次发送期间发生真实路由变化（pathname/search，不含仅 hash 锚点）时，旧 UI/所属读取失效，但 Provider 原包保留；迟到结果不在目标页面弹出旧恢复或覆盖当前 Workbench。同 Task 原包仍在发送时，重复点击或其他状态入口不会另发一条请求；切到另一 Task 后，旧请求的可核对 ACK 可以更新它仍拥有的原包，但不能刷新或覆盖新会话。包括已收起的包也随当前撤权、身份/空间切换和硬刷新清除；没有跨硬刷新持久队列。明确的 4xx 拒绝结束直接操作的原包并刷新当前状态；未知结果不按已拒绝处理。清除本地记录不等于撤回服务器已接受操作。

成功 ACK 须匹配原 Task ID、目标状态和原修订加一。确认的是原操作，当前 Task 可能已发生后来变化；之后 Workbench 读取失败显示请求已确认，“刷新任务状态”只发送 GET，不重发业务 POST。原 Store 状态命令在进入 mutate 前检查当前权限，回执保留原 Task；父 PR56 已修补既有授权时序缺口，在 `BEGIN IMMEDIATE` 之后、读取 complete/cancel/reopen 旧回执之前再次核对当前 Task 编辑权。该补丁不是移植引入的回归，也不新增回执模型。普通创建的对应权限时序另按[创建/编辑说明](task-edit-baseline.md)补齐；这里只指创建、PATCH 与状态三类普通 Task 命令，不概称全系统回执均已补齐。HTTP 路由仍有原停止协调，读取旧回执不等于整个 HTTP 路径零工作。

实现见[state](../../apps/web/src/state.tsx)、[任务详情](../../apps/web/src/task-workspace.tsx)、[成果](../../apps/web/src/results.tsx)和[原协议回归](../../tests/task-status-replay.test.ts)，父来源与实际检查见[整合记录](../development/history/2026-10-02-task-reliability-integration.md)，直接路径的诊断与独立验证见[本次记录](../development/history/2026-10-02-direct-task-status-recovery.md)。浏览器流程分别见[已取消重开](../../tests/e2e/cancelled-task-reopen.spec.ts)、[完成确认](../../tests/e2e/task-completion-dialog.spec.ts)、[详情取消](../../tests/e2e/task-cancellation.spec.ts)、[确认弹窗原请求恢复](../../tests/e2e/task-status-request-recovery.spec.ts)与[直接状态恢复](../../tests/e2e/direct-task-status-recovery.spec.ts)。本候选不新增 API、后端回执模型、完成记录列表、取消原因字段、Run 状态或数据库迁移。
