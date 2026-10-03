# 普通 Task 创建的原请求恢复

> 本页说明从冻结 PR57 开始的独立普通创建候选；实现与本地静态/定向检查已完成，真实浏览器、CI 与原图验收仍待完成，实际状态见 [21](../development/21-implementation-status.md)。未表示这些改动已合并 main。

普通新建仍只提交标题、说明和项目，使用当前空间内的既有 Task 创建接口；它不启动 Run，也不增加需求模型、后端字段、schema 或回执协议。创建预算继续使用既有独立 96 KiB JSON 限制与原字符上限。

第一次提交前，Provider 固定原始正文、身份、空间、路径、项目名称与 Idempotency-Key。未知结果时，标题、说明和项目锁定，选择“确认原创建结果”重发完全相同的原请求。关闭或导航不撤回可能已提交的操作，之后任一新建入口都先显示未结原包，不能换项目或换一把键另建。

有效创建 ACK 单独保存，并核对 Task UUID、HX 编号、原身份的负责人/创建者、原空间/项目/可见性、经现有 `parseTaskCreate` 规范化后的标题和说明、todo/修订 1/空 attention，以及相同且有效的创建/更新时间。规范化仅用于核对回执，不改原重试正文；当前 Workbench/SSE 投影不替代原创建 ACK。缺失或不匹配的 ACK 保持未知，不能导航到其中的 Task。

有效 ACK 后 Workbench 读取失败，界面显示已创建编号，“刷新已创建任务”只 GET，不再次 POST。重复点击与重开入口共用在途保护。迟到的有效 ACK 可记录到仍属于它的原包，但不能启动旧界面的刷新、关闭后来界面或抢回导航；旧 POST/拒绝/finally 及创建所属读取均核对包与会话，读取还尊重后来的成功快照。

当前项目创建权限失效、身份/空间变化或自己的 POST 明确返回 401/403/404 时，清除不再可用的原内容与请求；重新授权不复活。其他明确 4xx 拒绝结束该原包并恢复原输入以供编辑；网络、5xx 和无效 ACK 保留锁定原包，等待明确确认。临时读取故障不当作权限撤销。

client 的可选 `shouldNotifyAccessLoss` 仅由创建 POST 与其所属 Workbench GET 使用，控制全局认证/空间撤权通知；默认其他请求行为和抛出的 ApiError 不变。它按原 Provider 代次、当前身份/空间与请求空间判断：来自旧身份/空间的迟到拒绝不能重置新 Provider，同一 Provider 的真实拒绝在弹窗已关闭或原包已清除后仍正常广播。创建所属 GET 还尊重后来的成功读取，旧读取的拒绝或成功不能覆盖新快照；这项身份失效判断与弹窗会话归属分开。

尚未发送的草稿在新建表单本地，关闭即丢弃。已经发送的未结包在既有 Provider 内存中，跨暂时关闭或站内导航保留；二者都不写浏览器持久存储，不跨硬刷新或身份/空间 Provider 更换。

实现见[普通新建表单](../../apps/web/src/forms.tsx)、[Provider](../../apps/web/src/state.tsx)、[创建恢复 hook](../../apps/web/src/task-creation.ts)与[client 通知守卫](../../packages/client/src/index.ts)。原问题的真实 HTTP 复现、修正验证与限制见[独立记录](../development/history/2026-10-03-task-creation-request-recovery.md)；开发约束见[项目与任务](../harness/projects-tasks.md#普通-task-创建的原请求恢复)。
