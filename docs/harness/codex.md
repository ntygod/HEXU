# Codex 协议与保留会话 harness

> 按需读取：修改 Codex App Server、thread/turn 映射、模型配置或 retainSessions/resume。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

保留/恢复还要遵守 [提供方共用约束](providers.md#保留会话的共用约束)；不需要为了单独修改 Codex 协议而通读 Claude transcript 规则。

- 目标：[09 工作包](../development/09-codex.md)；使用：[Codex 私有会话](../engineering/codex-sessions.md)。
- 代码：[适配器](../../packages/adapters/codex/src/index.ts)、[本机会话](../../apps/runner/src/agent/codex-sessions.ts)、[preview 宿主](../../apps/runner/src/runtime.ts)。
- 使用独立 OPENAI_API_KEY；JSONL RPC 有界。thread sandbox 使用 kebab-case，turn sandbox 使用 camelCase；UI 事件不得含原始思考链或凭证。空 Hooks 使用命名空数组，项目路径使用 inline TOML projects map，避免 dotted path 引号问题。

## 保留、恢复与终态

Default stays ephemeral. Only locally confirmed Codex retainSessions:true enables a private per-session CODEX_HOME; preview remains ephemeral; Claude uses a separate opt-in vault; see [Claude harness](claude.md). Bind recovery to node/control origin/project/task/directory identities, executable realpath, full policy/version/mode and an exact-key HMAC kept only in the local journal. Do not import personal sessions or accept browser thread IDs, history or paths. Public events contain only an opaque reference and restoration deadline, never the native transcript or account fingerprint.

Restore only the latest successful, termination-confirmed source, explicitly through a direct new Run; wait Operations remain new-session-only. Check metadata with thread/read, then thread/resume with restricted configuration, verify ID/cwd/model/approval/sandbox, and only then turn/start. Check cancellation before each next step. Failure never falls back to thread/start. Keep ready only after successful provider completion and confirmed process termination; interrupted state is blocked on restart. Seven days is a restore deadline, not deletion. Local cleanup requires confirmed terminal execution and does not delete task history or code. Raw native history must never be included in UI events.

Protocol fixtures exercise real process/HTTP/file mechanics, not real model generation. Document official no-model checks separately from fixture success and valid-account interoperability. Native history will be inherited during resume even if some current notes are unchecked; the UI must say this before consent.

## 如何验证与回写

按改动运行对应 Codex/节点会话测试，使用明确假 Key 和协议替身。可选 `npm run check:codex-protocol -- /absolute/path/to/codex` 仅核对官方二进制的无模型初始化/配置；它不认证、不发起 turn，不能代替真实账户联调。具体已核验版本看工程说明和实现历史。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

共同进程/权限要求见 [执行](execution.md) / [节点](nodes.md)。修改跨工具恢复时对照 [Claude](claude.md)，不能复制协议或共享凭证。
