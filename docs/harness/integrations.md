# 选择性整合 harness

> 按需读取：IntegrationOperation、固定成果到目标目录、完整对象三方预检，以及后续实际应用。目标见[13工作包](../development/13-parallel-exploration.md)，当前用法见[整合预检](../engineering/integration-preflight.md)。

## 当前实现与稳定边界

- 一条Task内固定一个ResultRevision、其原共同起点/代码引用、本人目标Node/WorkingCopy提交和独立恢复副本。源/目标当前权限分别核对，再核对原回执；后续成果或方案选择不漂移固定来源。
- IntegrationOperation与Run、选择记录、Task完成分别保存。预检计划始终只读；另存明确应用选择与阶段，当前本地仅支持已有父目录中的普通文件新增。不能用旧预检作为写入许可。创建/取消/报告、历史、outbox、幂等结果保持原子性；节点报告不可覆盖，取消不抹掉旧证据。
- 复用保留对象或已确认的接收副本，不读取截断的ResultCodeDifference还原代码。传输接收的副本保持独立来源与期限，不借源凭证。到期、撤权、缺失/损坏不能回源修补或自动续期。
- 原方案共同起点的完整对象从目标已授权仓库按固定commit/tree核验；源/目标副本逐对象重验完整图、覆盖率和快照指纹。目标HEAD、索引、全部文件/模式与固定提交一致；额外、忽略或未知写入拒绝并保留。只读占用检查不是未来写锁。
- 文件级三方比较保留目标独有文件；双方修改一律显式冲突，组合后检查目录、大小写和NFC碰撞。符号链接/LFS/子模块/歧义路径/空子树阻止完整计划，80文件/48 KiB省略明确标记。不要让“无冲突”变成质量验收或自动应用。
- 节点先本机确认读取，再展示有界文件名/对象信息，另行确认共享；无正文/绝对路径。共享前持久化固定包，未知回复只对账原包。明确取消且服务端无报告时可以结算本机原待发包；权限不明时保留，不偷换新操作。
- 界面保留固定版本/编辑基线与选择，短暂读取错误不丢输入；确认时来源、目标和当前任务修订一致。未知请求沿用原body/key，撤权清除编辑。历史计划与当前材料可用性分开呈现。

## 明确应用与后续写入边界

[应用流程](../engineering/integration-application.md)另行确认选择和本机写入，完整重验后持久记意图、获取共享工作区锁，以匿名inode+linkat排他新增；不支持时失败，不降级覆盖。每个文件先记意图、后记真实inode，最终验证原目标树与已写选择的精确并集；不能泛化忽略untracked。中断/部分失败保留现场和锁，重启只对账。已持久完成后的共享ACK未知不重写；断开/重新配对须持有同一应用进程守卫贯穿凭证变化，待决或未知应用不能删原凭证。未知现场另走[明确停止后的保留结算](../engineering/integration-recovery.md)：原应用/子进程停止只能由操作者确认，精确租约删除与释放收据同事务，重复只读原收据而不触及后来写入者；全部文件/原报告不变。原应用与结算包分开对账，元数据发布只核对原目标/Task当前权限，不读撤权来源。

[私有试应用](../engineering/integration-trial.md)只在新的独立目录组合完整目标与明确选中的来源新增/修改/删除，保留未选目标内容；不能从显示diff拼字节，也不将候选发布当成原目录应用。固定清单与逐项意图/所有权先持久化，最终重查完整材料、期限、原目标及暂存字节后不覆盖发布。中断不续写/不清理，同输出重复只返回历史；尚有暂存/未知材料时同一进程守卫必须阻止删除原凭证。此处确认仅授权独立材料，不授权共享或写回。

普通Git目录的Linux只读预检不具有原目录覆盖能力，linked worktree、Windows/macOS与远程部署未交付。应用须明确新的写入授权、选择范围和冲突处理，重验目标/对象与恢复点，持有持久工作区锁并记录写入阶段。不得借旧预检自动commit/reset/stash、调用模型或清理用户修改；未知部分写入不能盲目回滚。先读[检查点](checkpoints.md)与[执行](execution.md)，需要目录写入时补读[节点](nodes.md)。

## 修改与验证入口

- [契约](../../packages/contracts/src/integrations.ts)、[事务/权限](../../packages/db/src/integrations.ts)、[API](../../apps/control/src/integrations.ts)、[迁移](../../packages/db/src/schema.ts)。
- [节点预检](../../apps/runner/src/agent/integration-preflight.ts)、[纯计划](../../apps/runner/src/agent/integration-plan.ts)、[干净提交核验](../../apps/runner/src/agent/committed-workspace.ts)。方案接续复用最后一项，仍保留原绑定父目录/Git身份检查。
- [试应用完整计划](../../apps/runner/src/agent/integration-trial-plan.ts)、[试应用写入与私有日志](../../apps/runner/src/agent/integration-trial.ts)、[纯组合测试](../../tests/integration-trial-plan.test.ts)、[真实目录/崩溃/凭证测试](../../tests/integration-trial-runner.test.ts)。
- [精确租约收据](../../tests/workspace-release.test.ts)、[结算事务](../../tests/integration-recovery.test.ts)、[本机结算/断线/进程退出](../../tests/integration-recovery-runner.test.ts)、[结算浏览器](../../tests/e2e/integration-recovery.spec.ts)。
- [应用事务用例](../../tests/integration-application.test.ts)、[真实应用/进程退出](../../tests/integration-application-runner.test.ts)、[排他新增原语](../../tests/integration-add-files.test.ts)、[应用浏览器](../../tests/e2e/integration-application.spec.ts)。
- [控制层用例](../../tests/integrations.test.ts)、[三方规则](../../tests/integration-plan.test.ts)、[真实Git/对象/HTTP](../../tests/integration-runner.test.ts)、[浏览器](../../tests/e2e/branch-results.spec.ts)。改公共目录核验时补跑[方案接续](../../tests/branch-continuation-runner.test.ts)。按风险最少验证，不把协议替身当真实模型互操作。

文档与交付保持[19](../development/19-work-items.md)/[21](../development/21-implementation-status.md)/[22](../development/22-next-delivery.md)的单一职责，详细证据写历史。
