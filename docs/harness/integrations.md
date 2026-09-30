# 选择性整合 harness

> 按需读取：IntegrationOperation、固定成果到目标目录、完整对象三方预检，以及后续实际应用。目标见[13工作包](../development/13-parallel-exploration.md)，当前用法见[整合预检](../engineering/integration-preflight.md)。

## 当前实现与稳定边界

- 一条Task内固定一个ResultRevision、其原共同起点/代码引用、本人目标Node/WorkingCopy提交和独立恢复副本。源/目标当前权限分别核对，再核对原回执；后续成果或方案选择不漂移固定来源。
- IntegrationOperation与Run、选择记录、Task完成分别保存。当前只有只读计划，没有写入许可或已应用状态。创建/取消/报告、历史、outbox、幂等结果保持原子性；节点报告不可覆盖，取消不抹掉旧证据。
- 复用保留对象或已确认的接收副本，不读取截断的ResultCodeDifference还原代码。传输接收的副本保持独立来源与期限，不借源凭证。到期、撤权、缺失/损坏不能回源修补或自动续期。
- 原方案共同起点的完整对象从目标已授权仓库按固定commit/tree核验；源/目标副本逐对象重验完整图、覆盖率和快照指纹。目标HEAD、索引、全部文件/模式与固定提交一致；额外、忽略或未知写入拒绝并保留。只读占用检查不是未来写锁。
- 文件级三方比较保留目标独有文件；双方修改一律显式冲突，组合后检查目录、大小写和NFC碰撞。符号链接/LFS/子模块/歧义路径/空子树阻止完整计划，80文件/48 KiB省略明确标记。不要让“无冲突”变成质量验收或自动应用。
- 节点先本机确认读取，再展示有界文件名/对象信息，另行确认共享；无正文/绝对路径。共享前持久化固定包，未知回复只对账原包。明确取消且服务端无报告时可以结算本机原待发包；权限不明时保留，不偷换新操作。
- 界面保留固定版本/编辑基线与选择，短暂读取错误不丢输入；确认时来源、目标和当前任务修订一致。未知请求沿用原body/key，撤权清除编辑。历史计划与当前材料可用性分开呈现。

## 后续写入不可越过

本轮普通Git目录的Linux只读预检不具有原目录覆盖能力，linked worktree、Windows/macOS与远程部署未交付。应用须明确新的写入授权、选择范围和冲突处理，重验目标/对象与恢复点，持有持久工作区锁并记录写入阶段。不得借旧预检自动commit/reset/stash、调用模型或清理用户修改；未知部分写入不能盲目回滚。先读[检查点](checkpoints.md)与[执行](execution.md)，需要目录写入时补读[节点](nodes.md)。

## 修改与验证入口

- [契约](../../packages/contracts/src/integrations.ts)、[事务/权限](../../packages/db/src/integrations.ts)、[API](../../apps/control/src/integrations.ts)、[迁移](../../packages/db/src/schema.ts)。
- [节点预检](../../apps/runner/src/agent/integration-preflight.ts)、[纯计划](../../apps/runner/src/agent/integration-plan.ts)、[干净提交核验](../../apps/runner/src/agent/committed-workspace.ts)。方案接续复用最后一项，仍保留原绑定父目录/Git身份检查。
- [控制层用例](../../tests/integrations.test.ts)、[三方规则](../../tests/integration-plan.test.ts)、[真实Git/对象/HTTP](../../tests/integration-runner.test.ts)、[浏览器](../../tests/e2e/branch-results.spec.ts)。改公共目录核验时补跑[方案接续](../../tests/branch-continuation-runner.test.ts)。按风险最少验证，不把协议替身当真实模型互操作。

文档与交付保持[19](../development/19-work-items.md)/[21](../development/21-implementation-status.md)/[22](../development/22-next-delivery.md)的单一职责，详细证据写历史。
