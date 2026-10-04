# 成果版本与反馈 harness

> 按需读取：修改 Result/ResultRevision、来源快照、成果版本展示或反馈锚点。目标见 [14 工作包](../development/14-results-feedback.md)，当前操作见[方案成果](../engineering/branch-results.md)。

## 入口与不变量

- [契约](../../packages/contracts/src/results.ts)、[版本仓储](../../packages/db/src/result-revisions.ts)与[成果页](../../apps/web/src/results.tsx)复用现有 Result。Result 是当前投影，ResultRevision 不可变；普通分享创建初始版本，方案后续保存追加版本，不覆盖正文历史。
- [方案保存](../../packages/db/src/work-branch-results.ts)核对 Task/分支/Run/dispatch/已登记现场。只接受明确终态与终止确认；来源取固定命令及已共享事件，不用 Task 的混合消息列表推断来源 Run。失败和取消保留原状态，不改成工具成功。
- [只读来源预览](../../packages/db/src/work-branch-result-source.ts)保留兼容接口和24 KiB共享输出前缀，与固定成果的6000字符/终态文本优先展示分别表述。两者共用持久结算边界和`shared:false`排除；旧边界未知时不补推输出，预览不是保存回执。合并修改复用[接口一致性检查](../../tests/work-branch-result-merge.test.ts)。
- `terminal_sequence` 固定结算边界；`shared:false` 的撤权/迟到事件不采用。没有可靠旧边界时保留缺失事实，不追认未知历史输出。输出有预算和截取标志，不等同完整日志。
- 默认版本只固定文字、来源与限制，代码状态为 `not_captured`；选填代码引用必须来自同一方案节点/目录，且由本人在来源Run结束后明确记录。初始 checkpoint、WorkingCopy 变更数量、模拟预览和终态成功不能充当本轮代码产物。提交引用、对象副本、共享差异与可恢复现场分别记录。
- Result、不可变版本、分支关联/修订/历史、outbox 和回执同事务。先验证当前父任务权限再读旧回执；原回执固定原版本，不返回最新版本冒充原保存结果。ready 仅表示存在可查看成果。
- 新反馈绑定明确版本，同 Task/Result 再校验；旧未锚定反馈不迁移到某一版本。任务完成不要求成果或报告，反馈不直接调用模型。

## UI 与升级

版本切换/深链接与刷新保持锚点，新版本提醒不能替换正在看的旧版。详情显式固定链接使用已加载的 result.id 与 version.id，加载期不拼接未知 ID；单版本也可通过普通链接打开/复制地址，不新增剪贴板权限或自动重定向。Task 已完成或取消时，成果入口使用同一个明确重开动作；状态确认遵守[项目任务](projects-tasks.md#task-完成取消重开与未知结果)，不重写成果版本。浏览器测试先取得固定版本 ID，等待指定新版本加载后再选择；不要在加载期从空选项数组推算旧版目标。编辑基线固定，冲突由人核对；临时读取故障保留，撤权清除，未知写入只确认原正文/来源/键。身份/空间变化不带走草稿，沿用 [UI](ui.md) 和 [身份](identity.md)。

迁移仅保留已知旧正文的一个版本，来源标为 legacy，未知作者/更早版本/反馈锚点不猜测。未来扩充文件/差异/预览时保留既有不可变记录及权限；需要代码读取再补读[检查点](checkpoints.md)。

## 比较与验证

[代码契约](../../packages/contracts/src/result-code.ts)、[关联/报告事务](../../packages/db/src/result-code.ts)、[节点读取](../../apps/runner/src/agent/result-code.ts)和[只读对比](../../apps/web/src/result-code.tsx)仅固定已选择提交。引用保存与旧回执均校验当前本人/节点/目录及Run终态；关联副本必须当前有效，后续到期/删除只改变读取投影，不改写旧版本。

新差异通道需要本机两次明确同意：先读取指定提交，再共享已展示的有界文件名/正文；不改变原checkpoint/retention/report通道只传元数据的边界。复用隔离Git对象读取与完整哈希核验，不调用git diff驱动、hooks或工作目录代码。执行日志/工作区占用需核对，但不得清除未知锁。UI只显示文字内容，不执行HTML或将显示包当作完整补丁。

差异按版本只保存一次，待发包先落私有日志；未知回复只重发原包，当前撤权阻止旧包发布。服务检查版本/引用/预算、结构与文本blob哈希，原始树归属来自原节点核验；不虚构服务端完整对象验证。相关检查见[代码事务/预算](../../tests/result-code.test.ts)与[Linux真实Git/HTTP](../../tests/result-code-runner.test.ts)，用法和具体范围见[固定代码](../engineering/result-code.md)。

方案比较/选择按[并行 harness](parallel.md)，选择只固定版本，不自动整合/执行/停止。相关测试为[成果事务](../../tests/branch-results.test.ts)、[选择事务](../../tests/branch-comparison.test.ts)与[浏览器流程](../../tests/e2e/branch-results.spec.ts)。控制层夹具明确预置现场绑定并发送协议事件，不计作真实文件恢复或模型生成；原 Linux 进程/文件测试保留在 branch-workspaces。

检查错来源、旧修订、事务回滚、当前权限/旧回执、输出边界、迁移和旧反馈；界面验证临时错误/未知回复/撤权与窄屏。并发测试允许任一请求先完成认证，只断言唯一提交与实际胜出请求的回执；自建浏览器夹具先关闭其上下文/连接，再关闭服务。仅按实际改动选择验证，进度回写 [19](../development/19-work-items.md)/[21](../development/21-implementation-status.md)，下一项在 [22](../development/22-next-delivery.md)。
