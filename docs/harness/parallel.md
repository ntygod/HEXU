# 方案分支与隔离并行 harness

> 按需读取：定义同一 Task 的多个方案、共同代码/材料起点，或继续实现独立现场、执行关联、对比和整合。目标见 [13 工作包](../development/13-parallel-exploration.md)；当前用法见 [方案定义](../engineering/work-branches.md)。

## 当前实现

[契约](../../packages/contracts/src/work-branches.ts)、[事务](../../packages/db/src/work-branches.ts)、[路由](../../apps/control/src/work-branches.ts)与[任务抽屉](../../apps/web/src/work-branches.tsx)提供项目任务的方案定义。每组2—6条，固定当时 Task 标题/说明/修订和已发布的同任务 CommitCheckpoint，保存共同起点哈希。原引用只代表提交引用，不能推导对象存在、目录授权或完整历史。

- 定义原子保存 group、全部 planned 分支、各自事件、outbox 与原请求回执。不会复制 Task、创建目录、调用模型或填写 Run/Result。只读和直接 ID、历史、SSE、旧回执都按当前父任务权限读取；跨任务引用和私有任务不能混入当前项目切片。
- 保存的共同起点与各方案目标不可暗中跟随任务变化；网页编辑基线固定，明确核对后才更新修订。临时读错保留，确实撤权清除编辑；仍有读权限的历史不因降权收起。原请求重试不重新创建部分方案。
- 当前只允许 planned 明确转 discarded，记录独立修订与历史；丢弃定义不等于停止执行、删除目录或改变 Task 状态。没有独立 WorkingCopy/Run/Result 时字段保持 null，不伪造 active/ready/selected。

## 继续开发时保持

有代码写入的方案需要各自独立 WorkingCopy 和明确共同材料。所有分支只能来自同一选定提交/快照，不能把一条含未提交改动的现场和另一条 HEAD 说成同一起点。材料需要新核验和当前授权，历史定义不是新的对象读取授权。

复用现有 Node/Run/dispatch/一次性许可及持久工作区锁，不建立第二套调度或任务系统。各方案工具/模型与费用取实际配置，未选择不填虚构默认；准备/排队不是执行，定义不是并行成功。不自动启动多次付费调用。

选中仅记录选择，不自动合并或停止其他 Run；隔离工作目录不是 OS/数据库/端口/凭证隔离。后续整合固定源结果与目标修订，先保存恢复起点，冲突保留供用户处理；未知写入与未保存修改不清理。剩余切片只在 [22](../development/22-next-delivery.md) 维护。

## 验证与跨边界

复用[方案事务测试](../../tests/work-branches.test.ts)和[检查点浏览器流程](../../tests/e2e/checkpoint-retention.spec.ts)；核对真实提交引用、部分事务回滚、重复请求、修订冲突、撤权/事件过滤、历史和刷新，不把空目录/模拟结果写成真实并行。Git/写入读[检查点](checkpoints.md)，实际调度读[执行](execution.md)与[节点](nodes.md)，界面读[UI](ui.md)，权限读[身份](identity.md)。
