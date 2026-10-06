# 工作说明编辑的固定基线与原请求确认

> 本页说明 main 基线 Task 可靠性候选中的行为；候选自身验证状态见 [21](../development/21-implementation-status.md)。未表示这些修正已合并 main。

“编辑工作说明”只修改同一个 Task 的标题、说明和关注事项，不建立独立 Requirement、内容历史或新的执行命令。编辑从明确 Task ID、修订号和原文开始；外部更新可展示原/当前内容，不静默提高提交修订或替换草稿。冲突、暂时读取故障和明确未成功的写入保留当前输入；载入新基线须由成员明确选择。

未知写入只确认同一原 PATCH 正文、修订和 Idempotency-Key，不把最新 Task 投影冒充原保存回执。旧回应不能清掉新草稿、关闭后来打开的编辑器或把导航抢回来；关闭界面不撤回已发送到服务端的操作。

临时草稿/原包在既有 Provider 内存按身份、空间和 Task 隔离，不写浏览器持久存储。当前 Workbench 仍可见时，暂时任务读取失败保留已有内容并提示重读；成功 Workbench 移除 Task，或详情明确拒绝访问时，清除旧内容、抽屉、编辑草稿和原包。重新授权不复活旧状态。

后台复用原 Task PATCH、当前编辑权限、expectedRevision、Task/outbox/回执事务；事务内读取旧回执之前再次核对当前 Task 编辑权。普通 `beforeReplay` 回调是从 [PR33](https://github.com/ntygod/HEXU/pull/33) 提取的最小依赖，不导入其成果编辑功能或迁移。Task 状态、负责人、访问范围、Run、Operation 和冻结材料不由此表单扩大修改。

标题 160、说明 12000、关注事项 300 字符限制保持。Task PATCH 和普通创建 POST 各使用独立 96 KiB 请求预算，容纳既有合法中文及全 Unicode 转义 JSON；不放宽字符契约、未知字段或全局 32 KiB 预算。新建仍只是创建 Task，不执行模型。本候选另修复原普通创建的权限时序缺口：`BEGIN IMMEDIATE` 之后、读取旧回执之前复核 team 当前空间权限，再检查非空项目的编辑权；私有 Task 创建/原回执同样受当前空间权限约束。真实第二 SQLite 连接的权限变化单独覆盖，不能把先前调用前检查视为同一证据。

实现见[编辑器](../../apps/web/src/task-content-editor.tsx)、[原 Task 事务](../../packages/db/src/store.ts)、[控制路由](../../apps/control/src/app.ts)。工程入口为[编辑回归](../../tests/task-edit-baseline.test.ts)、[创建预算](../../tests/task-create-budget.test.ts)与[浏览器流程](../../tests/e2e/task-edit-baseline.spec.ts)，候选来源与实际检查见[整合记录](../development/history/2026-10-02-task-reliability-integration.md)。不包含内容历史、恢复旧版本、附件或自动模型输入。
