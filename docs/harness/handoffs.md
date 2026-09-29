# 正式接手邀请 harness

> 按需读取：修改 Handoff 发布/关闭/到期/历史、任务内接手卡，或后续接受接手。先读 [12 工作包](../development/12-handoff-sharing.md)；当前用法见 [接手邀请](../engineering/handoff-invitations.md)。

## 当前实现与边界

- [契约](../../packages/contracts/src/handoffs.ts)、[状态规则](../../packages/domain/src/handoffs.ts)、[事务](../../packages/db/src/handoffs.ts)、[路由](../../apps/control/src/handoffs.ts)、[抽屉](../../apps/web/src/handoffs.tsx) 只实现 offered / rejected / withdrawn / expired。准备编辑留在抽屉内存，明确发布一次保存。
- 仅真实账号、项目可见任务、原发送者向不同的原接收者发出邀请。绑定已确认接收的 transfer ID/hash、接收节点/用户、commit、快照指纹、材料期限与覆盖范围；不能从任务阅读权、配对、旧恢复报告或任意浏览器路径推导材料授权。
- 发布前及事务内核对当前任务/双方节点权限、固定材料和 Task revision；旧回执前仍核对当前权限。接收人仅可拒绝，发布人仅可撤回；归档不禁止这类人类协作。当前父任务权限控制列表、直接 ID、历史和 SSE，邀请不是 AccessGrant。
- 邀请有独立修订，不改 Task revision、负责人、操作者、Run、Operation、输入材料、工作区锁或本机文件。状态、不可变事件、outbox 与原请求回执一并提交；旧回执返回最新状态，不能再次产生副作用。到期单独持久化系统事件，重启不复活。
- 摘要、剩余工作、环境说明与发布时任务标题/版本固定；后续变化只作比较提示。期限是邀请可处理期限，不是对象删除或进程终止证明。

## 接受接手不能用历史记录代替

`received` 仅说明对象接收最后回执，`restored` 是一次历史发布结果。真正接受必须有接收者自己的新现场核验、当前双方权限、固定来源版本、目标目录和写入冲突核对，再提交 accepted / 操作者变化。不能因为用户读到邀请而自动恢复文件、使用旧授权、改派任务或启动付费执行。

后续切片范围只在 [22](../development/22-next-delivery.md) 维护。仍共用一个 Task，不新建平行 AI 会话系统，不加质量报告门槛，也不复制发送者凭证。负责人可选转移和操作者切换是不同语义。

## UI 与验证

固定表单基线；临时读错保留，明确撤权或身份/空间变化清除。未知写确认克隆的原 body/key，不能用刷新后的修订重写原请求。已发布卡片按当前权限读取，深浅色和窄屏使用 W1 tokens。

复用 [邀请工程测试](../../tests/handoffs.test.ts) 和 [检查点浏览器流程](../../tests/e2e/checkpoint-retention.spec.ts)：真实双账号/双节点材料、冲突/撤权/幂等回执、事务回滚、到期/重启与原任务无副作用。按本次实际改动选择检查；不要为接手邀请调用真实模型。

涉及对象或目录读写时补读 [检查点](checkpoints.md)，节点/会话用 [节点](nodes.md)，权限和呈现分别用 [身份](identity.md) / [UI](ui.md)。
