# 回复具体成果反馈

在固定版本的反馈下选择「回复这条反馈」，先核对原作者、原正文摘录和已有代码位置，再输入回复。回复仍保存在原Task和同一ResultRevision。任务讨论也显示直接回复对象，点击「查看原反馈」回到原版本的原消息；代码反馈另保留原文件/侧/blob与行范围链接。回复另一条回复时显示直接父消息，不另建评审任务或多层会话。

## 来源和边界

服务只接受正文；Task、ResultRevision、直接父反馈、作者和可选代码锚点均从当前有权读取的原消息派生。只允许同Task、同Result及同固定版本的真人反馈。普通版本文字反馈可以回复，不虚构代码位置；旧未指定版本、系统或工具消息不能从此入口回复。旧反馈未记录明确作者ID时，仅保留原名称，不反推身份。

直接父反馈快照保存消息ID、原名称、已知作者ID和至多240个UTF-16单位的正文摘录，不截断代理对，并标记是否省略；原完整正文继续保留。客户端不能用请求字段换作者、版本、父反馈或锚点。后来的成果不改挂旧回复，不补读仓库正文，也不会调度模型。

## 权限、草稿与回执

- 当前Task编辑权限在事务前以及事务内回执重放前检查；重新获得权限后从新的空白编辑器开始
- 原Task消息、来源快照、outbox和幂等回执同一事务；相同键/正文只生成一条回复，改正文复用旧键被拒绝
- 草稿按账号/空间Provider内存、Task/ResultRevision和原消息隔离；关闭或页面会话内导航保留，硬刷新不恢复
- 未知发送结果只确认原正文/来源/幂等键；关闭不撤回请求。降权清空草稿后，晚到回执不能恢复它或覆盖新草稿
- 临时读取故障沿用原成果页保留已显示的固定历史；当前撤权清空不可见内容

回复不会把内容采用为下一轮要求，不创建后续Task；这些仍需后续独立选择。当前功能不支持未指定版本的历史反馈迁移或跨空间分享。

## 实现与验证

POST `/api/v1/results/:resultId/versions/:revisionId/feedback/:messageId/replies` 接受 `{body}` 和既有Idempotency-Key，返回原Task的Message。沿用messages JSON记录，无新任务表。`replyTo`是服务派生的显示快照；普通消息接口保持原行为。已有`mutate`增加可选事务前置核对回调，仅本接口使用，在旧回执前执行。

[契约](../../packages/contracts/src/result-feedback-replies.ts)、[来源核对](../../packages/db/src/result-feedback-replies.ts)、[编辑器](../../apps/web/src/result-feedback-reply.tsx)、[任务/成果讨论](../../apps/web/src/discussion.tsx)。具体检查和未完成范围见[历史](../development/history/2026-09-30-feedback-replies.md)。
