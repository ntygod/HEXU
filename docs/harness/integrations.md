# 选择性整合 harness

> 按需读取：IntegrationOperation、固定成果到目标目录、完整对象三方预检，以及后续实际应用。目标见[13工作包](../development/13-parallel-exploration.md)，当前用法见[整合预检](../engineering/integration-preflight.md)。

## 当前实现与稳定边界

- 一条Task内固定一个ResultRevision、其原共同起点/代码引用、本人目标Node/WorkingCopy提交和独立恢复副本。源/目标当前权限分别核对，再核对原回执；后续成果或方案选择不漂移固定来源。
- IntegrationOperation与Run、选择记录、Task完成分别保存。预检计划始终只读；另存明确应用选择与阶段，旧新增应用支持普通文件新增及有界排他新父目录，不能覆盖已有文件/目录；固定候选写回必须另行确认候选/报告/完整路径与原文件备份，新输入指纹不能让旧runner当成ADD请求。不能用旧预检作为写入许可。创建/取消/报告、历史、outbox、幂等结果保持原子性；节点报告不可覆盖，取消不抹掉旧证据。
- 复用保留对象或已确认的接收副本，不读取截断的ResultCodeDifference还原代码。传输接收的副本保持独立来源与期限，不借源凭证。到期、撤权、缺失/损坏不能回源修补或自动续期。
- 原方案共同起点的完整对象从目标已授权仓库按固定commit/tree核验；源/目标副本逐对象重验完整图、覆盖率和快照指纹。目标HEAD、索引、全部文件/模式与固定提交一致；额外、忽略或未知写入拒绝并保留。只读占用检查不是未来写锁。
- 文件级三方比较保留目标独有文件；双方修改一律显式冲突，组合后检查目录、大小写和NFC碰撞。符号链接/LFS/子模块/歧义路径/空子树阻止完整计划，80文件/48 KiB省略明确标记。不要让“无冲突”变成质量验收或自动应用。
- 节点先本机确认读取，再展示有界文件名/对象信息，另行确认共享；无正文/绝对路径。共享前持久化固定包，未知回复只对账原包。明确取消且服务端无报告时可以结算本机原待发包；权限不明时保留，不偷换新操作。
- 界面保留固定版本/编辑基线与选择，短暂读取错误不丢输入；确认时来源、目标和当前任务修订一致。未知请求沿用原body/key，撤权清除编辑。历史计划与当前材料可用性分开呈现。

## 明确应用与后续写入边界

[应用流程](../engineering/integration-application.md)另行确认选择和本机写入，完整重验后持久记意图、获取共享工作区锁，以匿名inode+linkat排他新增；不支持时失败，不降级覆盖。新父目录复用私有空暂存和不覆盖发布，目录意图/阶段身份/已创建归属分别持久；旧祖先冻结，新祖先只接受本次证据，不接管后来出现的目录。每个文件先记意图、后记真实inode，最终验证原目标树与本次目录/文件的精确并集；不能泛化忽略untracked。中断/部分失败保留现场和锁，重启只对账。已持久完成后的共享ACK未知不重写；断开/重新配对须持有同一应用进程守卫贯穿凭证变化，待决或未知应用不能删原凭证。未知现场另走[明确停止后的保留结算](../engineering/integration-recovery.md)：原应用及所有integration-add/restore-publish子进程停止只能由操作者确认，精确租约删除与释放收据同事务，重复只读原收据而不触及后来写入者；全部文件/原报告不变。原应用与结算包分开对账，元数据发布只核对原目标/Task当前权限，不读撤权来源。

[私有试应用](../engineering/integration-trial.md)只在新的独立目录组合完整目标与明确选中的来源新增/修改/删除，保留未选目标内容；不能从显示diff拼字节，也不将候选发布当成原目录应用。固定清单与逐项意图/所有权先持久化，最终重查完整材料、期限、原目标及暂存字节后不覆盖发布。中断不续写/不清理，同输出重复只返回历史；尚有暂存/未知材料时同一进程守卫必须阻止删除原凭证。此处确认仅授权独立材料，不授权共享或写回。

[候选差异](../engineering/integration-trial-differences.md)复用同一整合，先本机确认读取完整对象及已明确发布的候选，再确认共享完整所选路径与有界正文；页面试应用选区与仅新增的真实应用入口独立。正文只能来自原核验对象映射，额外/编辑后的候选不能成为新输入。每试应用ID一份不可变报告，同操作多个候选保留历史；当前权限先于精确回执，待发包不重读重算，报告与outbox同事务且不改变原操作/应用状态。查看的候选ID固定，最新提示不能替换旧详情。

普通Git目录的Linux只读预检不具有原目录覆盖能力，linked worktree、Windows/macOS与远程部署未交付。应用须明确新的写入授权、选择范围和冲突处理，重验目标/对象与恢复点，持有持久工作区锁并记录写入阶段。不得借旧预检自动commit/reset/stash、调用模型或清理用户修改；未知部分写入不能盲目回滚。先读[检查点](checkpoints.md)与[执行](execution.md)，需要目录写入时补读[节点](nodes.md)。

## 修改与验证入口

- [契约](../../packages/contracts/src/integrations.ts)、[事务/权限](../../packages/db/src/integrations.ts)、[API](../../apps/control/src/integrations.ts)、[迁移](../../packages/db/src/schema.ts)。
- [节点预检](../../apps/runner/src/agent/integration-preflight.ts)、[纯计划](../../apps/runner/src/agent/integration-plan.ts)、[干净提交核验](../../apps/runner/src/agent/committed-workspace.ts)。方案接续复用最后一项，仍保留原绑定父目录/Git身份检查。
- [试应用完整计划](../../apps/runner/src/agent/integration-trial-plan.ts)、[试应用写入与私有日志](../../apps/runner/src/agent/integration-trial.ts)、[纯组合测试](../../tests/integration-trial-plan.test.ts)、[真实目录/崩溃/凭证测试](../../tests/integration-trial-runner.test.ts)。
- [精确租约收据](../../tests/workspace-release.test.ts)、[结算事务](../../tests/integration-recovery.test.ts)、[本机结算/断线/进程退出](../../tests/integration-recovery-runner.test.ts)、[结算浏览器](../../tests/e2e/integration-recovery.spec.ts)。
- [应用事务用例](../../tests/integration-application.test.ts)、[真实应用/进程退出](../../tests/integration-application-runner.test.ts)、[排他新增原语](../../tests/integration-add-files.test.ts)、[应用浏览器](../../tests/e2e/integration-application.spec.ts)。
- [控制层用例](../../tests/integrations.test.ts)、[三方规则](../../tests/integration-plan.test.ts)、[真实Git/对象/HTTP](../../tests/integration-runner.test.ts)、[浏览器](../../tests/e2e/branch-results.spec.ts)。改公共目录核验时补跑[方案接续](../../tests/branch-continuation-runner.test.ts)。按风险最少验证，不把协议替身当真实模型互操作。

文档与交付保持[19](../development/19-work-items.md)/[21](../development/21-implementation-status.md)/[22](../development/22-next-delivery.md)的单一职责，详细证据写历史。

## 固定候选已有文件写回

原生新增/替换助手必须为v2：尝试linkat命名发布后仅EEXIST可报告确定未写入，I/O等其他错误均为未知。应用与恢复调用方不得清掉原文件意图或释放原写锁，也不以文件存在补造成功、重试或回滚。旧v1须拒绝并要求构建，见[修复记录](../development/history/2026-10-07-integration-link-io-uncertainty.md)。

候选差异保持只读历史，新应用另行绑定其trialId、共享报告和本机清单指纹及完整路径；当前Task/节点/材料权限与修订先于旧回执。原节点确认停止其他写入者并指定同文件系统的新私有备份，备份必须与所有代码/候选/节点状态隔离且不能接管已有目录。沿用原应用日志、进程守卫、工作区锁、阶段与保留结算，旧记录不补造候选或备份归属。

普通文件原inode保留到私有备份；替换用RENAME_EXCHANGE，移出用RENAME_NOREPLACE，不unlink或降级普通覆盖。rename不是内容CAS，不能声称阻止所有非受管并发编辑；已知异常或未知材料保留两处现场/意图，不逆向交换、自动清理或重放。完整对象和候选、目标并集、备份字节/身份与最后短观察都须核对。已完整完成的原应用可另行明确恢复全部文件，见下节；未知/部分应用恢复、特殊权限/ACL/属性和冲突处理仍另行交付。

## 已完成应用的明确文件恢复

[恢复入口](../engineering/integration-file-restoration.md)只反转原应用全部已确认路径，要求原完成ACK2和精确备份/目标身份；另存一次固定请求、独立阶段/取消修订，原Operation和应用历史不可变。目标侧当前授权独立于来源材料可用性，不读取/修补/续期保留对象。原删除文件排他恢复时不能扩大备份普通读权限；写后字节/身份/权限须核对。原备份不消耗，当前文件另存新的私有目录，原创建空目录保留。

恢复记录在既有本机applications表使用判别类型与独立claim，旧runner严格拒绝未知记录以保留凭证。逐文件意图、精确并集/短观察、进程守卫和未知留锁沿用原边界；重启仅对账。保留结算使用同一原子租约收据，绑定恢复证据和唯一已冻结待发包，原应用/恢复阶段/结算不互相重写，旧包不能重新取得写入许可或解锁后来写入者。部分/未知原应用、后续用户修改和冲突解决仍另行处理，不扩成泛用备份系统。

实现：[恢复编排](../../apps/runner/src/agent/integration-file-restoration.ts)、[严格日志](../../apps/runner/src/agent/integration-restoration-record.ts)、[原备份读取](../../apps/runner/src/agent/integration-original-backup.ts)、[恢复保留结算](../../apps/runner/src/agent/integration-restoration-recovery.ts)。验证：[服务事务](../../tests/integration-file-restoration.test.ts)、[真实本机/进程](../../tests/integration-file-restoration-runner.test.ts)、[浏览器流程](../../tests/e2e/integration-restoration.spec.ts)。

## 整文件明确冲突选择

[版本2冲突选择](../engineering/integration-conflict-choices.md)仅处理both_changed普通文件，初始未处理，整文件take_source/keep_target分别记录；实际来源路径与保留目标决策合计80项/48KiB，选择不等于写回许可。三个完整对象和原不可变报告先重验，再由明确决策计算target→candidate有效变化；不能改原action、伪造base=null或放宽旧ADD/V1。私有清单/日志/共享报告显式版本2并绑定决策；旧runner拒绝未知参数/记录，原候选只能原包对账。

全保留目标可形成0变化候选并共享决策，但不创建空application、取原目标写锁或伪报completed。保留目标项不进入实际备份/恢复；未知或未选冲突仍未处理。原path_collision及最终并集的目录/大小写/NFC碰撞继续拒绝。界面重新核对不是目标重算；后续新目标需新固定检查点/恢复副本、新操作和新确认，不覆写旧预检，不自动commit/reset/stash。

核心：[决策契约](../../packages/contracts/src/integration-conflict-selection.ts)、[纯有效变更](../../packages/domain/src/integration-conflict-selection.ts)、[完整候选](../../apps/runner/src/agent/integration-trial-plan.ts)。检查：[纯规则](../../tests/integration-conflict-selection.test.ts)、[服务](../../tests/integration-conflict-service.test.ts)、[真实流程](../../tests/integration-conflict-runner.test.ts)、[重放](../../tests/integration-conflict-replay.test.ts)、[页面](../../tests/e2e/integration-conflict-selection.spec.ts)。


## 固定原来源的新目标重新预检

[专用入口](../engineering/integration-target-recompute.md)从原不可变报告派生精确原来源/共同起点与原本人节点/目录身份，只允许选择新的检查点/恢复副本及当前兼容来源材料。旧材料到期与当前授权分开；当前原来源/目标、新材料授权先于精确回执，创建事务内再核对修订、未结算应用/恢复和新鲜材料。新queued操作、事件/outbox/回执原子，原历史/候选/选择/应用/恢复/Task均不改写。recomputedFrom仅作历史链接，不改现有执行输入hash或升级写入许可。

不新增节点协议、锁接管或恢复系统。原待发预检包必须先原样对账，新ID不改投旧包；原应用/恢复的明确保留结算不等于目录当前空闲，既有本机占用/身份/完整对象/干净提交检查继续阻止后来写入者和用户修改。界面两个材料选项不默认，未知请求跨关闭保留body/key，临时失败保留但禁提交，明确重核清除确认，撤权清除；新候选与写回重新选择。验证入口：[服务](../../tests/integration-recompute.test.ts)、[真实Git](../../tests/integration-recompute-runner.test.ts)、[页面](../../tests/e2e/integration-recompute.spec.ts)。


## 已知未发布试应用暂存处置

[本机明确清理](../engineering/integration-trial-cleanup.md)仅允许原本人身份、failed/interrupted、staging、精确stageIdentity、无未决意图/发布/共享差异的原暂存。共用试应用进程守卫，原父链/目录身份和完整所有权先核对，用户另行确认所有原进程/子进程/孤儿及其他写入者停止并永久删除指定暂存；确认后重验，持久意图先于精确归属清理。不能推断外部进程实际已停，不能用递归rm、force、任意路径或目标存在猜测归属。

原历史/清单/所有权条目保持，另有绑定原证据的cleanup收据；成功只解除这条试应用的凭证阻塞，未知清理继续留凭证，不据目录缺失补造成功。重复已确认收据不读删后来目录；旧runner仍按旧未结算材料拒绝断开。不释放代码工作区锁，不读服务/来源对象，不处理已发布候选、用户编辑或未知材料。验证：[真实文件与CLI](../../tests/integration-trial-cleanup.test.ts)。
