# Claude Code 协议与保留会话 harness

> 按需读取：修改 Claude CLI 参数、JSONL、初始化检查或 retainSessions/resume。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

保留/恢复还要遵守 [提供方共用约束](providers.md#保留会话的共用约束)；不需要为了单独修改 Claude 协议而通读 Codex RPC。

- 目标：[08 工作包](../development/08-claude-code.md)；使用：[Claude 私有会话](../engineering/claude-sessions.md)。
- 代码：[适配器](../../packages/adapters/claude-code/src/index.ts)、[本机会话](../../apps/runner/src/agent/claude-sessions.ts)、[纯文本宿主](../../apps/runner/src/text-claude.ts)。
- 只调用明确配置的 CLI，以 API Key 和 bare/restricted 文件工具运行；没有 bypass、隐藏 SDK 或订阅账户回退。

## 保留、恢复与终态

Default Claude/preview arguments include --no-session-persistence. Only local retainSessions:true enables a private HOME + CLAUDE_CONFIG_DIR and CLAUDE_CODE_PROJECT_DIR_NAME=work. Generate a UUID locally; use --session-id for creation and only that UUID with --resume. Never use personal HOME, imported history, --continue, names, user paths or fork-session. Keep the same binding/latest-success/terminal requirements as Codex but never copy its RPC protocol.

Keep Claude native transcript format opaque. Check the documented private transcript location and bounded whole-vault content fingerprint before resume; persist ready only after matching init/result/model and confirmed process termination with files synced. Keep metadata and provider IDs local. File limits (4096 entries/64 MiB/depth 16) are checks, not a continuous quota. Both providers have separate 32-record capacity. Account/key rotation or modified history requires explicit new work.

Validate init ID/cwd/model/dontAsk/tools/empty MCP before accepting session output; resumed model is pinned to the saved resolved model. ID checks do not prove no model request occurred before init; do not claim zero charge after process launch. Failure/stop/unknown never silently starts a fresh paid turn or clears workspace claims. Optional check:claude-protocol uses no key and a nonexistent UUID, not a real successful session. The exact 2.1.283 hidden --max-turns help exception cannot waive restriction flags or become a blanket version claim.

## 如何验证与回写

复用 Claude/节点会话及 [纯文本执行](../../tests/ai-node.test.ts) 中相关用例；显式覆盖继承的原生命令/Key。可选无模型检查不能被算作已有真实会话成功恢复；真实模型不可用不阻断与账户无关的产品开发。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

共同进程/权限要求见 [执行](execution.md) / [节点](nodes.md)；无工具 AI 协助的独立同意和输出边界见 [协助](assistance.md)。
