# 04｜轻量任务、需求说明与项目规划

> D1 · M1—M3 · 关联 HX-F02/F03 · 依赖：02、03。  
> [计划入口](README.md) · [状态依据](../product/05-domain-and-state.md) · [API 总表](18-data-api-catalog.md)

## 1. 产品路径

从标题或自然语言直接建任务，负责人和项目自动带入。复杂工作可追加需求说明、子任务和里程碑；创建前不要求填写验收人、报告、故事点或工时。项目列表、看板、任务详情和 AI 执行引用同一个 Task ID。

默认 todo / in_progress / done；cancelled 是辅助终态，归档独立。waiting_feedback、blocked、paused 属于 attention 信息，不与 Run 生命周期混合。可把待反馈渲染为看板视图，但不能让同一任务拥有互相矛盾的主状态。

## 2. 数据拆分

`tasks` 保存标题、描述、spaceId、projectId、visibility、ownerUserId、operatorUserId、status、revision、parentTaskId、priority、目标日期和归档时间。`task_participants`、`task_dependencies`、`task_attention`、`task_labels` 单独关联；依赖可指向任务或有来源的约定，不要求先填写接口契约文档。

`requirements` 和 `requirement_revisions` 保存可选需求说明；用关系表连接任务。一份需求可关联多项工作，同一工作可引用多个材料。`milestones` 承载命名目标和关联任务，不强制采用固定迭代。

`completion_events` 记录 complete/reopen、主体、人或明确自动规则、任务修订、时间和可选成果引用。没有 Evidence、Acceptance 外键，不把这两类旧对象重建为隐藏的必填条件。

## 3. 状态命令而不是任意覆盖

任务内容使用 PATCH 与 expectedRevision。完成、重新打开、取消和归档走语义命令，以便记录动作和处理活动执行。完成时若有运行，默认请求停止，也可明确选择只标记完成；两者都保留真实 Run 状态。

`POST /tasks/:taskId/complete` 接受 expectedRevision、activeRunAction（request_stop / leave_running）、可选说明。返回更新任务与停止请求摘要，不把请求停止表示成已经停止。

`POST /tasks/:taskId/reopen` 由有编辑权的人操作。done 任务启动新 Run 必须带 reopenTask=true；07 在事务中记录重新打开和派发。AI 自报成功不能直接调用不受限制的完成接口，工具身份不伪装真人。

项目自动完成规则默认关闭，在 16 通过明确配置接入 PR 事件。普通评论、代码变化、需求编辑不自动撤销历史完成。

## 4. 需求与规划 UI

新建任务使用轻量弹层/行内输入。详情直接进入工作区，在侧栏补字段；表单保存失败保留输入。需求编辑提供原文和 AI 建议，可逐段采用、修改、撤销；AI 建议的采用通过人可见的操作写共享修订。

列表、看板共享筛选：项目、负责人、参与者、状态、标签、等待原因。排序使用稳定 rank 与 revision，拖拽竞争返回冲突并刷新，不静默丢掉另一人的移动。键盘与菜单提供等价操作。

子任务可以批量创建，但不因全部子任务完成就无提示完成父任务。依赖形成循环时指出路径，先支持显式关联与小图，不一开始做大型甘特图或自动排程引擎。

## 5. 六个工作项

| ID | 工作内容 | 产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-04-01 | 实现 Task 表、归属默认值、CRUD、权限与修订比较 | task module、迁移、client | 03、01-04 |
| HX-DEV-04-02 | 实现完成/重开/取消/归档与 CompletionEvent，关联停止请求 | task commands、事件 | 04-01、07 契约 |
| HX-DEV-04-03 | 接入列表、看板、排序、筛选、attention 与轻量新建 | 项目任务页面 | 04-01、02 |
| HX-DEV-04-04 | 实现可选需求说明、修订、附件、AI 建议局部采用 | requirement editor/API | 04-01、05 附件/草稿接口 |
| HX-DEV-04-05 | 实现子任务、依赖、标签、里程碑与按需关系视图 | planning 模块 | 04-01、04-03 |
| HX-DEV-04-06 | 统一项目/个人入口、搜索深链接与任务工作区加载数据 | task summary/detail DTO | 04-01—05、10 接口 |

## 6. 边界与联动

内容保存不依赖原生 Agent 可用。AI 说明整理在 08/09 接入后增强，之前可人工编辑，避免 04 与 05/工具形成硬循环。05 负责通用附件和草稿能力，04 只负责采用到需求的业务动作。

任务改派不修改旧 Run 的执行配置，不转移目录或账号。暂缓任务也不是原生进程暂停。UI 根据字段展示事实，不要求研发团队为了保持首页整洁填百分比。

交付时给后续模块稳定的 TaskSummary、TaskDetail、TaskCommandResult 与事件；不让每个页面自己推断任务是否“质量通过”。

## 7. 已交付的 04-01 负责人切片

项目可见任务已接入 `GET/POST /tasks/:id/assignment` 与分页 `assignment-history`。有任务编辑权的人可选择当前空间/项目中有 edit/manage 权限的真人；负责人不是访问授权，私有任务和跨空间转移不在本次范围。Task.ownerUserId 与新 Task/Run 的 createdByUserId 分开，迁移 11 不根据旧负责人补造创建者。

改派、改派历史、等待 Operation 暂停、outbox 和幂等回执同事务提交；保留 Run、节点授权和冻结材料，不发停止或新执行。已获许可执行不因改派被撤回；尚未许可的派发仍受任务修订检查，拒绝旧材料后不自动重试。W1 入口含明确冲突处理、原请求回执确认和权限变化清理。完整筛选与正式存储仍未交付，工作项保持部分实现。使用与验证见 [任务改派](../engineering/task-assignment.md) 和 [21](21-implementation-status.md)。

## 8. 已交付的参与者与人员筛选切片

04-01 增加当前项目成员参与关系，独立修订/历史/回执原子持久化。成员可自行加入/退出，包括只读成员；编辑者可管理他人，但参与不授予访问或执行权。项目/空间撤权原子结束参与，重新入组不复活，私有任务不借此共享。关系不属于当前模型材料，不改变 Task 修订、Run/Operation 或代码锁。

04-03/06 的项目列表/看板/API 共用负责人、当前参与者、标题/编号/说明交集筛选，项目 URL 保存条件与视图；同一 Task 读取 DTO 提供参与者投影，旧数据不补造参与历史。完整状态/标签/attention 筛选、持久排序和完整规划模型仍待实现，不将工作项提前标为完成。见 [参与者与筛选](../engineering/task-participants.md)。
