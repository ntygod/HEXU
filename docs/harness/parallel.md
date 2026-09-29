# 方案分支与隔离并行 harness

> 按需读取：定义同一 Task 的多个方案、共同代码/材料起点，或继续实现独立现场、执行关联、对比和整合。目标见 [13 工作包](../development/13-parallel-exploration.md)；当前用法见 [方案定义](../engineering/work-branches.md)。

## 当前实现

[契约](../../packages/contracts/src/work-branches.ts)、[事务](../../packages/db/src/work-branches.ts)、[路由](../../apps/control/src/work-branches.ts)与[任务抽屉](../../apps/web/src/work-branches.tsx)提供项目任务的方案定义。每组2—6条，固定当时 Task 标题/说明/修订和已发布的同任务 CommitCheckpoint，保存共同起点哈希。原引用只代表提交引用，不能推导对象存在、目录授权或完整历史。

- 定义原子保存 group、全部 planned 分支、各自事件、outbox 与原请求回执。不会复制 Task、创建目录、调用模型或填写 Run/Result。只读和直接 ID、历史、SSE、旧回执都按当前父任务权限读取；跨任务引用和私有任务不能混入当前项目切片。
- 保存的共同起点与各方案目标不可暗中跟随任务变化；网页编辑基线固定，明确核对后才更新修订。临时读错保留，确实撤权清除编辑；仍有读权限的历史不因降权收起。原请求重试不重新创建部分方案。
- 尚未持有准备/目录/Run的 planned 可明确转 discarded。现场登记后填写 WorkingCopy，派发同事务关联 Run，只有真实启动才记录 active；Result仍为null，不伪造ready/selected。丢弃定义、取消准备、停止Run及目录清理不是同一动作。

## 独立现场与首轮执行

[现场事务](../../packages/db/src/work-branch-workspaces.ts)、[本机编排](../../apps/runner/src/agent/branch-workspace.ts)、[真实起点复核](../../apps/runner/src/agent/branch-origin.ts)和[方案卡](../../apps/web/src/work-branch-workspaces.tsx)串起原本人副本、独立目录、新节点登记与首轮Run；用法见[现场指南](../engineering/branch-workspaces.md)。

- 固定原checkpoint/retention/manifest、分支、共同起点、本人/项目/空间与30分钟请求期限。源节点当前权限在旧创建回执前核对；Node Bearer与浏览器会话分开。新请求不等于目录存在，prepared是已收到本机证明，bound是新节点登记，不授予模型权限。
- 复用排他恢复和[共享Git准备](../../apps/runner/src/agent/restored-git-workspace.ts)，两个消费者分别保留接手/方案授权语义。新节点只得到自己的起点记录，不复制旧凭证/目录数组或发送者原生会话。目录、Git、配对、登记和执行逐次本机授权。
- 起点记录在私有文件中，服务仅接收哈希和不透明引用。节点首轮同时核对实际字节/模式/身份、HEAD、原始对象及从实际Git树重建的完整清单；不以自洽日志、工作区变更数量或旧报告代替共同代码起点。已交付副本使用自己的授权，不从原保留期限推断应删除代码。
- 准备/登记包先持久化，未知回执只重发原包；重启不继续文件写入或模型执行。未处置证据阻止原凭证删除，清理只处理本次完整归属的失败材料，发布成功的代码和Git保留；自己的只读准备预约在独占日志下对账，绝不清除未知模型占用。
- NodeExecution保留每节点单执行；仅同组、不同已登记现场允许并行。普通Task单派发和分支单派发各有数据库约束，Run/分支关联/事件/回执同事务。同组首个真实启动的自动todo→in_progress修订只更新匹配旧修订/上下文的排队同组派发，不能吞掉人类改动。
- 首轮只用固定共同说明、本方案目标和本次要求，不混入后续讨论、项目资料或旧会话。绑定目录不能从普通Run或接续绕过；后续分支接续需独立实现。单方案停止不停止其他Run，当前active是已开始的方案阶段，实际运行情况读关联Run，不标为成果ready。

## 继续开发时保持

有代码写入的方案需要各自独立 WorkingCopy 和明确共同材料。所有分支只能来自同一选定提交/快照，不能把一条含未提交改动的现场和另一条 HEAD 说成同一起点。材料需要新核验和当前授权，历史定义不是新的对象读取授权。

复用现有 Node/Run/dispatch/一次性许可及持久工作区锁，不建立第二套调度或任务系统。各方案工具/模型与费用取实际配置，未选择不填虚构默认；准备/排队不是执行，定义不是并行成功。不自动启动多次付费调用。

选中仅记录选择，不自动合并或停止其他 Run；隔离工作目录不是 OS/数据库/端口/凭证隔离。后续整合固定源结果与目标修订，先保存恢复起点，冲突保留供用户处理；未知写入与未保存修改不清理。剩余切片只在 [22](../development/22-next-delivery.md) 维护。

## 验证与跨边界

复用[方案定义](../../tests/work-branches.test.ts)、[真实现场与并发](../../tests/branch-workspaces.test.ts)和[浏览器流程](../../tests/e2e/checkpoint-retention.spec.ts)。检查原仓库/旧凭证不变、不同实际目录、Claude/Codex协议进程、固定输入、独立停止、权限/重复回执、部分失败和预算。浏览器需通过构建后的实际CLI运行需要Linux组件的路径，不绕过原生发布助手或放宽文件边界。Git/写入读[检查点](checkpoints.md)，实际调度读[执行](execution.md)与[节点](nodes.md)，界面读[UI](ui.md)，权限读[身份](identity.md)。
