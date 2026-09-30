# 方案清理前的现场保护核对

本入口只核对已放弃方案的当前普通文件快照与明确选中的独立对象副本。**没有目录删除、解绑、清锁或停止命令，也不会把检查通过变成未来删除许可。** 当前支持 Linux 本人同机节点。

## 用户流程

1. 在方案卡先明确[放弃并保留现场](branch-lifecycle.md)。活动/未知 Run 继续显示；如需停止，单独请求并等节点确认真正终止，不能据 discarded 推断结束。
2. 原节点本人点“清理前核对”。界面列出同一个 Node/WorkingCopy 当前有效的检查点副本，最多50个；同目录筛选先于检查点限额。初始不选择共同起点或最新版本。
3. 若没有副本，回到 Task 的“代码检查点”，由原本人记录当前**已存在提交**并明确[保留对象](checkpoint-retention.md)。引用不是副本；不要自动 commit、reset、stash 或丢弃用户修改。
4. 明确选定一个提交/副本，生成带固定方案、Task/分支修订、retentionId 的命令。把已加引号的状态目录占位符换成原方案节点私有目录。节点原同步进程需先退出，否则既有进程守卫拒绝；不向历史 PID 发信号。

```bash
npm run runner:branch-cleanup-check -- --branch BRANCH_ID --revision N --task-revision N --retention RETENTION_ID --state '/path/to/original-branch-state'
```

5. 本机先显示原方案、实际目录、提交和副本，明确输入 `CHECK_BRANCH BRANCH_ID` 后读取核验。成功结果仅输出本机，不自动上传检查报告、路径、文件名或代码。缺失/失败/取消保留原材料。

服务副本列表只是原记录，不证明当前目录干净。UI临时读取错误保留选择并隐藏失效命令；修订/材料变化需明确重核，撤权清空。关闭不会创建请求或执行命令，再开不会默认选择。

## 实际检查与边界

- 服务复查原 Task 编辑权、本人节点与目录授权、唯一原登记、discarded、原 Run 已确认终态及该节点无未终结派发。严格输入不接受任意路径、force、delete 或解锁字段。
- 本机复用原节点进程守卫、固定绑定与原起点身份核对；原根、Git和父链不能替换。同一目录当前受管/未知claim继续阻止，不获取、接管或释放工作区写锁。
- 执行、摘要及原登记待发证据须按原流程先结算；所选独立副本须已确认保留、未过期、当前有权且真实持久对象完整，不从仍存在的原目录修补损坏副本。
- 复用完整提交核验，HEAD、索引、全部普通文件/模式和实际对象须匹配所选提交。额外未跟踪、忽略、暂存或修改的用户文件也阻止通过，不只相信 Git dirty 数量。最终权限读取后再次检查观察身份/时间戳，防止核对期间的新编辑被报成旧成功。
- 使用既有私有节点日志与守卫，可能初始化既有执行表；不新增清理Operation/持久状态机、备份系统、清理日志、服务报告或删除回执。不声称整个本机状态逐字节只读；代码、HEAD/index、凭证、原绑定与对象不改写。

成功中的 `cleanSnapshotVerified` / `retainedSnapshotVerified` 只是本次观察；`deletionAuthorized`、`directoryDeleted`、`bindingReleased`、`workspaceReserved` 和 `unmanagedProcessesStopped` 均为false。没有停止非受管写入者，之后用户仍可继续编辑，旧输出不能用作未来删除凭据。

保留范围仅是所选提交的文件快照，不含 Git 祖先历史、其他分支/标签/未提交文件、外部LFS/子模块实体或任意私有数据。即使本次核对通过，也不能据此删除整个 `.git` 或现场。已登记目录的移动另走[完整现场移出并保留](branch-preservation.md)的新请求与两次本机确认，不复用此检查的同意；该流程不永久删除或自动授予保留位置执行权。本检查不宣称13-06全部完成。

## 实现与验证

[严格契约](../../packages/contracts/src/branch-cleanup-check.ts)、[只读服务](../../packages/db/src/branch-cleanup-check.ts)、[本机核对](../../apps/runner/src/agent/branch-cleanup-check.ts)、[界面](../../apps/web/src/branch-cleanup-check.tsx)。[服务回归](../../tests/branch-cleanup-check.test.ts)、[真实Git/CLI](../../tests/branch-cleanup-check-runner.test.ts)、[浏览器](../../tests/e2e/branch-cleanup-check.spec.ts)与[检查历史](../development/history/2026-09-30-branch-cleanup-check.md)。
