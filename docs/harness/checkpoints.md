# Git 检查点、对象保留与恢复 harness

> 按需读取：修改提交引用、原始 Git 对象读取、保留/核验/删除或计划中的新目录恢复。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[12 工作包](../development/12-handoff-sharing.md)；恢复的当前交付范围只在 [22](../development/22-next-delivery.md) 维护。
- 使用：[提交引用](../engineering/commit-checkpoints.md)、[对象保留](../engineering/checkpoint-retention.md)。
- 代码：[CLI 核对](../../apps/runner/src/agent/checkpoints.ts)、[对象遍历](../../apps/runner/src/agent/checkpoint-objects.ts)、[私有副本](../../apps/runner/src/agent/checkpoint-retention.ts)、[记录事务](../../packages/db/src/checkpoint-retention.ts)。

## 不可变提交引用

Team-local project tasks can explicitly request a full Git commit from their own paired node/directory. The owner runs `runner checkpoint --request ID --state HOME`, confirms the exact commit locally, and publishes bounded reference metadata. Summary pairing/polling never becomes arbitrary file-read RPC. Keep browser Cookie and node Bearer channels separate; current owner/task/project/node revision checks apply before every inspect/publish/replay.

The record verifies only raw commit/root-tree types, sizes and Git hashes in isolated metadata, supporting SHA-1/SHA-256 and standard linked worktrees. Reject alternate stores, symlinks and redirected commondir; no original config/hooks/filter/helper runs in cat-file. Use minimal safe temporary config for storage object format, never original repository config. Do not modify HEAD/index/worktree, commit/stash/reset/push/fetch, active Run/Operation or unknown claims. A working-copy count is only an observation; all mutable/ignored content is excluded.

`local_reference` is not backup, remote identity, retained objects or full graph/LFS/submodule restoration. Persist immutable records and state/outbox together. Local publication journal freezes uncertain results; repeating a successful request does not recapture or duplicate. Revoked nodes cannot inspect, publish or replay, even after membership returns; historical records remain under current task permissions. Separate 12-02 snapshot verification/explicit retention is described below; neither the old reference nor retained objects claim that target restoration is delivered. Keep original IDs and honest checks in 19/21/22/24.

## 本机独立对象保留

Keep commit references immutable. Retention needs a separate owner/task-authorized request, local per-request consent, bounded raw-object verification and an independent private SQLite copy. Only the selected commit snapshot's trees/blobs are retained: not ancestors, mutable files, LFS entities or submodule repositories. Parse tree names as bytes, never execute checkout/hooks/filters or turn names into filesystem writes. Revalidate source bindings and permission after traversal; verify persisted bytes before publishing metadata. No model calls or Task/Run/Operation/workspace mutations.

Manifest and reports are immutable; local pending evidence is durable and exact-sequence replay cannot recapture, renew or revive deletion. Report sequence100 is reserved for deletion after99 lifecycle observations. Expiry invalidates material use, not an automatic disk wipe; explicit local deletion removes only that bundle. Uncertain/revoked publication stays honest. Read metadata under current parent permissions, never upload names/code/paths/key bindings. Local byte storage is private but not encrypted or an OS sandbox. New browser retention cases use a separate disposable4317 process without changing auth/test limits.

Next is explicit independent-new-directory restoration per22, still unimplemented. Do not imply a local retained object snapshot proves live disk availability, complete external content, remote transfer or successful file restoration.

## 如何验证与回写

按改动复用 [引用事务](../../tests/checkpoints.test.ts)、[Git/CLI](../../tests/checkpoint-runner.test.ts)、[保留事务](../../tests/checkpoint-retention.test.ts)、[对象副本](../../tests/checkpoint-retention-runner.test.ts)。检查原仓库不变、链接/路径与绑定、损坏/缺失/到期、撤权和不确定回执，不通过真实用户目录测试删除。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

节点本人授权见 [节点](nodes.md)；新目录恢复不得从已有运行权限推导写入权。目标能力与边界以 [ADR-0008](../engineering/adr-0008-client-surfaces.md) 和 22 为准。
