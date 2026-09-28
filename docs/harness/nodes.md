# 节点配对与独立执行 harness

> 按需读取：修改节点凭证、配对、心跳、spool、派发许可、节点执行日志或撤销。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[06 工作包](../development/06-runner-workspaces.md)；使用：[节点摘要](../engineering/runner-node.md)、[独立执行](../engineering/runner-execution.md)。
- 代码：[节点注册](../../packages/db/src/nodes.ts)、[派发事务](../../packages/db/src/node-execution.ts)、[节点客户端](../../apps/runner/src/agent/connection.ts)、[执行器](../../apps/runner/src/agent/executor.ts)、[私有日志](../../apps/runner/src/agent/execution-journal.ts)、[本机策略](../../apps/runner/src/agent/execution-policy.ts)。

## 摘要配对

Node pairing authorizes only a fixed project and locally confirmed Git summary directories, never task execution. Keep browser Cookie and node Bearer channels separate. Server stores code/token hashes only; client credentials are fsynced before pairing exchange into a private state directory outside repositories. Do not upload absolute paths, filenames, code, branch/remotes, environment or provider keys. Never turn the summary endpoint into arbitrary RPC/command dispatch.

Preserve permanent node revocation on project/space removal; rejoining cannot revive credentials. Recheck project visibility for node metadata, even when the requester originally owned a revoked node. Connection presence is not Run state. A snapshot ACK means committed metadata, not accepted model work. Bounded local spool and exact sequence/hash replay must survive dropped replies; fail closed on divergence. Restart cannot spawn a model or signal a stale PID. Current protocol remains loopback HTTP and POSIX credentials; Windows, remote WSS/HTTPS and system credential storage are incomplete.

## 本人授权的独立执行

Metadata pairing remains metadata-only. enable-execution adds a separate locally confirmed bounded policy; only the node owner can dispatch to that node. Team control must never initialize host native resources or receive provider keys. Project editors may stop existing project executions; viewing a project is not permission to launch on another machine. Keep Cookie and Bearer channels separate and preserve strict request schemas.

Commit Run/dispatch/input/idempotency/outbox atomically. Journal accepted before ACK, preparing before requesting the one-use permit, and running only from actual spawn. Never replay launch permission or spawn a command already in the local journal. Persist overlapping-workspace claims shared with preview; crashes do not clear claims. Unknown process state requires explicit local stopped-process confirmation, never a stale PID signal or lease expiry. Unsettled evidence blocks credential deletion/re-pairing.

Persist bounded execution events before transport; ACK only committed matching sequence/hash. Revoked device credentials may settle only their already-bound dispatch, discarding output, never receive new commands. Terminal messages cannot complete a Task. Do not label independent node output as mock, or claim all startup phases were reached when a queued Run was cancelled. This remains loopback/POSIX owner execution with protocol fixtures; Claude/Codex retained-session resume are experimental independent-node paths; steer, delegated access, remote deployment and live-model verification are not delivered.

## 如何验证与回写

复用 [nodes](../../tests/nodes.test.ts)、[派发](../../tests/node-execution.test.ts)、[实际执行器](../../tests/node-executor.test.ts) 和 [节点浏览器流程](../../tests/e2e/node-execution.spec.ts)。按改动检查持久化先于 ACK、许可不重放、断线重启和撤权后的有限结算，不让测试调用真实账户。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

改进程/目录锁读 [执行](execution.md)，改继续输入读 [接续](continuation.md)，改身份读取读 [身份](identity.md)，改保留会话读 [提供方路由](providers.md)。
