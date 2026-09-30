# 固定原来源的新目标重新预检

当原预检之后目标已有新提交，或原材料到期需要另选副本时，在原 Task 的“整合预检”中打开原记录，点“使用新目标重新预检”。它创建一条新的只读 IntegrationOperation，**不更新原报告，也不授权写入**。

## 操作路径

1. 先自行明确处理目标现场，为已有提交记录新检查点并保留完整对象。新检查点必须是原本人节点、同一个注册目录、相同节点修订和仓库身份。未提交/额外/忽略文件不能冒充干净的新提交；界面不会自动 commit、reset、stash、清理或调用模型。
2. 抽屉固定展示原成果版本、来源提交、共同起点、原目标目录及原目标历史。即使成果已有更新版本，也不会替换原来源；旧恢复副本和来源副本到期/删除不会自动阻止选择新有效材料。
3. 明确选择新检查点与恢复副本，以及原来源版本在目标节点的当前完整对象。来源在另一节点时先通过既有传输入口确认接收。两项均不默认选择。新检查点 ID 与原记录不同；提交 OID 可以相同，表示操作者另行固定的新观察。
4. 核对并勾选仅创建新的只读预检。临时读取错误保留输入并禁提交；原修订、Task 或所选材料改变时需明确重新核对并重新确认。保存回复未知时只能确认原 body/key，关闭重开不会变成另一请求。
5. 保存后打开新记录，按既有 `runner:integration-plan -- --operation <新ID> --state <节点状态目录>` 操作。在原 Linux 节点重新输入 `PREFLIGHT <新ID>` 和 `SHARE_PREFLIGHT <新ID>`。本机核对当前完整对象、HEAD/index、文件、绑定身份和占用，仍不改代码。
6. 新计划的试应用、冲突选择、共享候选和实际写回全部重新选择并另行确认。新记录的“查看原预检记录”按固定 ID 返回原历史，不暗中跳到最新预检。

没有有效选项时，通过现有检查点/保留/传输入口准备，再重读选项并“重新核对新目标基线”。旧操作的材料不可用和原来源/目标当前权限失效是两回事；当前撤权不能借原回执创建或确认另一人的工作。

## 未完成的原操作

原应用处于 queued/applying/needs_attention 且没有独立保留结算时，不可使用此入口；应先明确取消尚未启动的请求，或在原节点处理并按既有 STOPPED 流程保留结算。原文件恢复 queued/restoring/needs_attention 同样需要它自己的终态或独立结算。

原应用/恢复终态或明确保留结算只允许准备另一条只读预检，不证明当前目录空闲、文件正确或原应用成功。本机现有未知/重叠租约、后来写入者与固定目录身份核对继续生效，不释放、接管或改写它们。

原本机预检待发包仍须先对账：新操作命令会被 `INTEGRATION_PENDING` 拦截，不能把旧包改投新 ID。原报告、选择、候选、应用、恢复、Task、Run 与 Result 记录保持原值。

## 契约与事务

- `GET /tasks/:taskId/integrations/:integrationId/recompute-options` 从原操作派生范围，按原 owner/node/workspace **先筛选后限制最近50个检查点**。不接受任意来源版本、目标路径或查询覆盖。
- `POST .../recompute` 只接受原操作/Task 的预期修订、原 reportHash、新 checkpoint/retention、来源材料 kind/id 与 `confirmPreflight:true`。服务端固定原来源，不接收客户端报告、冲突选择、候选、路径或 provenance。
- 当前原来源/目标与新材料授权先于旧回执；新创建在同一事务再次核对修订、资格、完整范围与新鲜材料。操作、第一条事件、outbox 与幂等回执共同提交或回滚。
- 新记录 queued、report:null、application:null、applied:false；服务端生成可选 `recomputedFrom` 历史关联，后续报告/取消保持。它不是写入许可，不改变原 inputHash 格式，也未新增数据库 trigger 不可变性承诺。普通旧记录兼容，沿用每 Task 100条上限。

只支持同一固定来源到同一目标目录的新只读比较，未扩展结构/文本冲突、选择提交/patch、多来源、特殊文件/权限或部分/未知原应用的自动恢复。完整独立安全审查仍未完成。

实现：[契约](../../packages/contracts/src/integration-recompute.ts)、[事务](../../packages/db/src/integrations.ts)、[界面](../../apps/web/src/integration-recompute.tsx)。验证：[服务](../../tests/integration-recompute.test.ts)、[真实Git](../../tests/integration-recompute-runner.test.ts)、[浏览器](../../tests/e2e/integration-recompute.spec.ts)，实际结果见[历史记录](../development/history/2026-09-30-integration-target-recompute.md)。
