# HEXU harness 目录

这些 harness 是仓库内的任务执行指南：说明何时读取、必须保留什么、到哪里改、怎样验证。它们不是 HEXU 产品中的 agent 层级，也不会创建新的任务系统、工具权限或后台服务。

## 渐进式读取

1. 根 [AGENTS.md](../../AGENTS.md) 提供稳定边界和任务路由。
2. 选择本次相关的一份或少量 harness。按路径和行为边界选择，不机械加载全部。
3. 需要细节时才打开指南链接的产品章节、工作包、代码和测试。已读且未变化的内容不用重复读。

Markdown 引用不等于工具已注入其内容；执行任务时必须实际打开相关文件。未添加跨目录覆盖规则，也不要求修改个人 Codex 配置。对于 Codex，根到当前目录的 AGENTS 加载/大小规则见 [官方说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)；此处通过明确路由使用普通文档，不假设链接会递归自动加载。

## 选择指南

| 工作范围 / 常见路径 | Harness |
| --- | --- |
| 工程分层、命令、验证、Git 与交付 | [development](development.md) |
| `apps/web`、`packages/ui` 的呈现与交互 | [ui](ui.md) |
| `packages/identity`、permissions、会话/SSE/访问策略 | [identity](identity.md) |
| project-settings/lifecycle、task-assignment/participants | [projects-tasks](projects-tasks.md) |
| sources/agreements/materials、AI drafts、选区与内容采用 | [context](context.md) |
| runtime/process-host/workspace-lease、Run 事务 | [execution](execution.md) |
| nodes、agent/connection/executor、策略/journal/许可 | [nodes](nodes.md) |
| continuations、node-continuations、next-inputs | [continuation](continuation.md) |
| provider 参数与会话；先选择工具 | [providers](providers.md) → [claude](claude.md) / [codex](codex.md) |
| assistance、text-claude、assistance-adoption | [assistance](assistance.md) |
| checkpoints、checkpoint-objects/retention、后续恢复 | [checkpoints](checkpoints.md) |
| handoffs、邀请状态/接手卡、后续接受与操作者 | [handoffs](handoffs.md) |
| README、AGENTS、文档入口/事实/历史 | [documentation](documentation.md) |

例如：只改按钮样式读 UI；改资料采用读上下文，涉及任务写事务再看项目任务；改节点接续读接续与节点，只有改变原生会话协议才打开对应 provider。跨包改动按真实影响补读，不以文件数量决定阅读范围。

## 维护

新增规则应写到拥有该行为的专题；根入口只加必要路由，不追加整段实现日志。专题保留“触发条件、入口、约束、相关验证”，可用能力/测试数量放 21，下一项放 22，历史放实现日志。完整归属与迁移核对见 [文档治理](documentation.md)。
