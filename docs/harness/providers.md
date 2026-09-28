# 提供方与会话：按工具选择

> 按需读取：修改原生工具协议、账号方式、模型目录、配置、会话保留或恢复。不是添加新的 agent runtime。

| 本次工具 | 指南 | 使用与事实 |
| --- | --- | --- |
| Claude Code | [Claude harness](claude.md) | [Claude 会话](../engineering/claude-sessions.md) |
| Codex App Server | [Codex harness](codex.md) | [Codex 会话](../engineering/codex-sessions.md) |

只读涉及的工具；跨工具转换才对照两份。两者共享 HEXU 的 Task/Run/Operation 与受管目录约束，不共享 API Key、原生协议或个人历史。默认不保留会话，恢复可用性由本机明确策略与真实来源证据决定。

## 保留会话的共用约束

仅在本机明确配置并确认 `retainSessions:true` 时启用各自私有目录；绑定控制地址、节点、项目、任务、目录身份、可执行文件 realpath、完整策略/版本/模式及仅保存在本机日志的精确 Key HMAC。不得导入个人历史，也不接受浏览器传入原生 thread/session ID 或路径。

只恢复最新成功且确认终止的来源，并明确创建新 Run；等待 Operation 仍使用新会话。两个工具分别有 32 条记录容量，7 天是恢复期限而非删除期限。Key/账户/策略改变、历史修改、失败/中断/未知状态不得静默换账号、新开付费回合或释放未知锁；重启阻止恢复被中断的状态。

公开仅使用不透明引用和期限，原生历史/身份指纹留在本机。恢复会继承原历史，即使本次未选某些材料也不能声称它们已从历史删除；本机清理需终态确认且不删除任务历史或代码。各工具仍必须执行自己的初始化/协议/落盘核对，不能由共同规则代替。

修改启动/停止/未知锁同时读 [执行](execution.md)，修改节点派发同时读 [节点](nodes.md)，修改等待安排读 [接续](continuation.md)。wait Operation 不自动成为 native resume。

模型目录、官方二进制无模型检查和真实账户互操作是不同事实。当前已验证版本/未验证范围查 [21](../development/21-implementation-status.md) 及对应工程说明，不在根 AGENTS.md 维护会过期的工具版本表。
