# Git 检查点、对象保留与恢复 harness

> 按需读取：修改提交引用、原始 Git 对象读取、保留/核验/删除或新目录恢复。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[12 工作包](../development/12-handoff-sharing.md)；恢复的当前交付范围只在 [22](../development/22-next-delivery.md) 维护。
- 使用：[提交引用](../engineering/commit-checkpoints.md)、[对象保留](../engineering/checkpoint-retention.md)、[只读恢复预检](../engineering/checkpoint-restore-plan.md)。
- 代码：[CLI 核对](../../apps/runner/src/agent/checkpoints.ts)、[对象遍历](../../apps/runner/src/agent/checkpoint-objects.ts)、[私有副本](../../apps/runner/src/agent/checkpoint-retention.ts)、[记录事务](../../packages/db/src/checkpoint-retention.ts)。

## 不可变提交引用

Team-local project tasks can explicitly request a full Git commit from their own paired node/directory. The owner runs `runner checkpoint --request ID --state HOME`, confirms the exact commit locally, and publishes bounded reference metadata. Summary pairing/polling never becomes arbitrary file-read RPC. Keep browser Cookie and node Bearer channels separate; current owner/task/project/node revision checks apply before every inspect/publish/replay.

The record verifies only raw commit/root-tree types, sizes and Git hashes in isolated metadata, supporting SHA-1/SHA-256 and standard linked worktrees. Reject alternate stores, symlinks and redirected commondir; no original config/hooks/filter/helper runs in cat-file. Use minimal safe temporary config for storage object format, never original repository config. Do not modify HEAD/index/worktree, commit/stash/reset/push/fetch, active Run/Operation or unknown claims. A working-copy count is only an observation; all mutable/ignored content is excluded.

`local_reference` is not backup, remote identity, retained objects or full graph/LFS/submodule restoration. Persist immutable records and state/outbox together. Local publication journal freezes uncertain results; repeating a successful request does not recapture or duplicate. Revoked nodes cannot inspect, publish or replay, even after membership returns; historical records remain under current task permissions. Separate 12-02 snapshot verification/explicit retention is described below; neither the old reference nor retained objects claim that target restoration is delivered. Keep original IDs and honest checks in 19/21/22/24.

## 本机独立对象保留

Keep commit references immutable. Retention needs a separate owner/task-authorized request, local per-request consent, bounded raw-object verification and an independent private SQLite copy. Only the selected commit snapshot's trees/blobs are retained: not ancestors, mutable files, LFS entities or submodule repositories. Parse tree names as bytes, never execute checkout/hooks/filters or turn names into filesystem writes. Revalidate source bindings and permission after traversal; verify persisted bytes before publishing metadata. No model calls or Task/Run/Operation/workspace mutations.

Manifest and reports are immutable; local pending evidence is durable and exact-sequence replay cannot recapture, renew or revive deletion. Report sequence100 is reserved for deletion after99 lifecycle observations. Expiry invalidates material use, not an automatic disk wipe; explicit local deletion removes only that bundle. Uncertain/revoked publication stays honest. Read metadata under current parent permissions, never upload names/code/paths/key bindings. Local byte storage is private but not encrypted or an OS sandbox. New browser retention cases use a separate disposable4317 process without changing auth/test limits.

## 只读恢复预检与写入边界

[计划核心](../../apps/runner/src/agent/checkpoint-restore-plan.ts) 和[本机编排](../../apps/runner/src/agent/checkpoint-restore-preflight.ts) 仅生成 Linux 普通文件/目录计划。原本人逐次 PLAN 同意后，从现有私有 SQLite 的只读快照核验持久对象，不初始化状态、不重新采集、不续期/修补/重放或发布保留回执。等待用户输入期间不持有数据库读事务；开始读取与返回文件名之前重查当前节点权限、原绑定、原清单与期限。路径和文件名只输出在本机，不新增浏览器任意路径 RPC。

名字不做静默改名：拒绝非 UTF-8、控制/格式字符、危险片段、大小写/规范化冲突、符号链接/LFS/子模块；展开体积按每个路径计数，不借重复对象绕过限制。已提交敏感文件仍可能包含在材料中，不能把排除节点凭证等外部状态说成过滤了所有秘密。

计划明确 restored=false、writeAuthorized=false。目标和父目录身份只是当前观察，不是预留、授权或抗竞态写入实现；实际写入必须重新检查并以排他/不覆盖语义发布，见下节。不得把计划、哈希或副本核验作为成功恢复、远程传输、完整外部内容或 Task/Run/Operation 已接管的证据。实际写入另走下述明确授权路径。

## 本机新目录恢复

[恢复编排](../../apps/runner/src/agent/checkpoint-restore.ts)、[文件边界](../../apps/runner/src/agent/checkpoint-restore-files.ts)、[本机日志](../../apps/runner/src/agent/checkpoint-restore-journal.ts) 与 [Linux 发布助手](../../apps/runner/src/native/restore-publish.c) 实现独立暂存和不覆盖发布。RESTORE 同意本次写入，PUBLISH 单独同意发布；不接受旧计划授权。等待确认时释放对象库读事务，发布前重查持久对象、原计划、当前身份/权限/期限、固定父目录及暂存字节。

固定目录描述符、精确 inode 身份、排他新建与 `RENAME_NOREPLACE` 不能退化为普通 rename/copy 或覆盖。源目录移动后的原授权身份仍受保护。Linux 构建需要本地 C 编译器；仅支持明确允许的本地文件系统，其他平台或缺助手必须失败。

意图先记日志，再创建材料；逐项记录所有权与实际进度。重启只记 interrupted/unknown，同目标重试只返回原记录，不重写或自动发布。同步/回执不确定不能借目标存在声称成功。清理需明确 CLEAN，只遍历本次完整所有权清单；用户新增/编辑、替换/链接或日志不完整时保留现场，永不递归删除用户目录或已发布目标。状态读取是本机最后记录，不是持续可用性保证；未来任务内报告不上传路径/文件名/字节或复用旧回执扩权。用法与限制见[恢复指南](../engineering/checkpoint-restore.md)。

## 如何验证与回写

按改动复用 [引用事务](../../tests/checkpoints.test.ts)、[Git/CLI](../../tests/checkpoint-runner.test.ts)、[保留事务](../../tests/checkpoint-retention.test.ts)、[对象副本](../../tests/checkpoint-retention-runner.test.ts)、[恢复计划](../../tests/checkpoint-restore-plan.test.ts)、[本机预检](../../tests/checkpoint-restore-preflight.test.ts)、[真实恢复](../../tests/checkpoint-restore-write.test.ts) 和[发布原语](../../tests/checkpoint-restore-files.test.ts)。检查原仓库不变、链接/路径与绑定、损坏/缺失/到期、撤权和不确定回执，不通过真实用户目录测试删除。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

节点本人授权见 [节点](nodes.md)；新目录恢复不得从已有运行权限推导写入权。目标能力与边界以 [ADR-0008](../engineering/adr-0008-client-surfaces.md) 和 22 为准。
