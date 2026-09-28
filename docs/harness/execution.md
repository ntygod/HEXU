# Run、进程与工作区 harness

> 按需读取：修改执行启动/停止、目录占用、崩溃恢复、模型材料与进程边界。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[06 Runner](../development/06-runner-workspaces.md)、[07 执行](../development/07-execution-events.md)；使用：[preview 原生执行](../engineering/native-execution.md)。
- 代码：[NativeRuntime](../../apps/runner/src/runtime.ts)、[进程宿主](../../apps/runner/src/process-host.ts)、[目录锁](../../apps/runner/src/workspace-lease.ts)、[Run 事务](../../packages/db/src/store.ts)、[纯领域状态](../../packages/domain/src/index.ts)。
- Task 是人的业务状态，Run 是一次执行，Operation 是持久安排。mock 不启动命令或调用模型；停止请求不是终止证据。

## 原生执行边界

Native mode is opt-in via local environment and explicit Git roots. Browser requests cannot register arbitrary paths or executable names. Do not enable Bash, MCP, repository hooks, subscription pooling or new network tools merely to make a task succeed. Native tool policies are not an OS sandbox. Preserve working-copy locks when stop cannot be confirmed; never signal a stale persisted PID after restart. Only the offline recovery command accepts the operator's explicit stopped-process confirmation. Task completion still requires no quality report.

Tests must override inherited native settings with a clearly named protocol fixture and fake key. Never use developer/provider credentials in CI. Document Linux-tested, macOS-unverified and Windows-unsupported boundaries. Keep capability detection separate from credential validity and actual model interoperability.

Continuation must preserve the explicit source Run and working-copy identity. Reject stale/foreign sources and active or uncertain writers; no implicit reset, stash, commit, upload, or identity transfer. Codex uses a separate OPENAI_API_KEY; do not forward it to Claude. Empty Hooks in Codex config are named empty arrays, not necessarily an empty object. Use an inline TOML projects map so dotted path overrides do not quote directory names incorrectly. Optional `check:codex-protocol` never authenticates or starts a model turn.

## 如何验证与回写

按所改路径复用 [原生](../../tests/native.test.ts)、[节点执行器](../../tests/node-executor.test.ts) 或 [接续](../../tests/continuations.test.ts) 测试。必须显式使用协议替身和假 Key，不能继承操作者密钥/命令。POSIX 流程以 Linux 为准；Windows 只跑适用的 UI/纯逻辑检查，不能据此声称原生支持。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

独立节点派发读 [节点](nodes.md)；等待与下一轮读 [接续](continuation.md)；工具协议/恢复读 [提供方路由](providers.md)；客户端与部署边界读 [ADR-0008](../engineering/adr-0008-client-surfaces.md)。
