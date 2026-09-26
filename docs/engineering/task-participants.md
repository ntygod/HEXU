# 任务参与者与项目人员筛选

对应 `HX-DEV-04-01/03/06` 的本机切片。参与者是协作关系，负责人是责任归属，Task/Run 创建者是历史操作者；三者都不能代替项目权限或节点执行授权。原工作项仍为部分实现。

## 使用

项目可见任务头部点击“参与者”。当前项目成员可以自行加入/退出，包括只读成员；有任务编辑权的人可以添加/移除当前项目成员。只读参与者不能因此修改任务、发起执行或管理其他参与者。preview 使用明确的虚构成员。

抽屉提供当前成员、此前参与状态和分页变更记录。参与操作逐次提交；并发修订不匹配返回 409，重新读取后由用户再次选择。回执不确定时只通过“确认上次参与操作”重放原 payload/key。关闭不撤销已发送的请求；身份/空间变化、任务撤权和编辑权变化会清除当前抽屉状态。历史阅读不被 SSE 自动重置。

项目看板和列表共用负责人、参与者和关键词交集。关键词匹配标题、编号和说明。`ownerUserId`、`participantUserId`、`q`、`view=list` 保存在项目 URL，支持刷新、返回和深链接；参与者只匹配当前仍有项目访问权的有效关系。已退出或只读的负责人有明确标记，失效链接保留筛选值而不偷偷回到全部任务。项目页仍显示原有非 cancelled 任务范围，完整状态/标签/attention 筛选与持久排序待后续交付。

## 权限和持久化

- `GET/POST /tasks/:id/participants`：读取关系/候选或提交 `{expectedRevision, action: add|remove, userId}`，返回 `{taskId, revision}`。只接受上述字段，禁止私有任务借此共享。
- `GET /tasks/:id/participants/history?before=<revision>&limit=10`：同任务权限，最多 50 条，以不可变参与修订分页。
- `GET /projects/:id/task-people`：当前空间与项目成员，以及该项目可见任务已记录的历史负责人；不查找无关身份或返回邮箱。
- `GET /spaces/:id/tasks` 接受同名人员/关键词参数，在当前任务权限和项目边界内筛选后分页。看板/列表复用相同纯领域条件。

迁移 12 新增 `task_participant_sets`、`task_participants`、`task_participant_events`。旧任务不会根据负责人或消息作者自动产生参与关系。集合初始修订为 1，实际关系变化才递增；关系、独立修订、历史、任务 outbox 和幂等回执同事务。写入和回放前均复核当前权限；管理他人需要编辑权，本人操作仍需要父任务读取权及有效成员资格。

项目/空间撤权在原成员事务中将有效关系变为 `access_revoked` 并记录操作者。重新加入项目不自动恢复参与；旧回执也不再次应用加入。本人退出参与不撤销既有项目访问；被移除的人不能再读取任务、参与记录或其 SSE。

参与关系拥有独立修订，**不修改 Task.revision、任务时间、负责人、模型上下文、Run、派发、已冻结 Operation 或代码锁**。它不属于本轮模型材料，所以正常增删不暂停已确认接续。真实权限变更仍受原成员撤权、节点许可和接续检查约束。归档项目允许人工参与协作；不会因此重新开放执行。

`Task.participantUserIds` 仅是详情/工作台/列表读取投影，不持久化到 Task JSON，也不发送为模型输入。历史姓名限于任务范围已记录的数据。没有私有任务邀请、跨空间分享、提及通知、委派运行或真人账户模型验证。

实现入口：`packages/contracts/src/task-participants.ts`、`packages/db/src/task-participants.ts`、`apps/web/src/task-participants.tsx`、`apps/web/src/project-task-filters.tsx`。实际检查见 [21](../development/21-implementation-status.md)。
