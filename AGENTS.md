# HEXU 开发入口

面向个人多工具/多模型 coding 与团队 AI coding，保持一个 Task 工作区。默认中文，沿用现有实现；明确任务自主完成，小改动不展开全仓重构或无关检查。

## 先定位任务

- 接手或继续计划开发：读 [接手指南](docs/development/24-ai-handoff.md)，再按需要查 [当前能力](docs/development/21-implementation-status.md) / [下一项](docs/development/22-next-delivery.md)。已知范围的小修正只读相关文件。
- 改行为：读 [产品 v1.1](docs/product/03-functional-specification.md) 的相关章节及对应 [工作包](docs/development/README.md)。W1 已交付，不重新启动旧 UI 重建。
- 改动前核对 Git 状态和当前分支，保留其他人的工作。实现事实以代码和验证记录为据；计划、演示、工具探测不代表能力已交付。

## 按任务加载 harness

修改下列范围前，打开对应指南；跨边界时补读相关指南即可，不必一次加载全部。具体代码、测试和工程说明在各指南内。

| 本次工作 | 读取 |
| --- | --- |
| 工程结构、契约分层、验证、提交与接手 | [开发流程](docs/harness/development.md) |
| 页面、交互、主题、抽屉、输入状态 | [UI](docs/harness/ui.md) |
| 账号、权限、会话、SSE 可见性 | [身份](docs/harness/identity.md) |
| 项目设置/归档、任务改派/参与/筛选 | [项目与任务](docs/harness/projects-tasks.md) |
| 资料、约定、选材、草稿采用 | [上下文](docs/harness/context.md) |
| Run、进程、停止、工作区锁 | [执行](docs/harness/execution.md) |
| 节点配对、凭证、派发、ACK/重放 | [节点](docs/harness/nodes.md) |
| 下一轮要求、等待接续、Operation | [接续](docs/harness/continuation.md) |
| Claude/Codex 参数、协议、原生恢复 | [提供方路由](docs/harness/providers.md) |
| 真人/AI 协助、分享授权、建议采用 | [协助](docs/harness/assistance.md) |
| Git 引用、对象副本、恢复与清理 | [检查点](docs/harness/checkpoints.md) |
| 接手邀请、关闭/到期、后续操作者接管 | [接手](docs/harness/handoffs.md) |
| 方案共同起点、独立分支、比较与选择 | [方案分支](docs/harness/parallel.md) |
| 整合固定来源/目标、完整对象与冲突预检 | [整合](docs/harness/integrations.md) |
| 成果版本、来源快照与版本反馈 | [成果](docs/harness/results.md) |
| 文档、AGENTS、harness 与进度维护 | [文档治理](docs/harness/documentation.md) |

完整索引与组合示例见 [harness 目录](docs/harness/README.md)。引用文件需要按任务实际打开；链接本身不代表已加载其中规则。

## 始终保持的边界

- 不重建 AI 员工层级、第二套任务/会话系统或强制质量报告门槛；Task、Run 与各类 Operation 分别记录，接手提交不等于启动执行。
- 当前 preview / team-local 只允许回环访问。模拟器不执行命令或调用模型；真实账号、SSH 可登录和参考演示都不代表已支持远程部署。
- 当前权限、修订与幂等结果一起核对；业务变更、回执和 outbox 保持原子性。不能借旧回执绕过撤权。
- 停止请求不是终止确认；未知进程保留工作区锁，重启不重放付费执行，不向过期 PID 发信号。不得暗中扩大工具/目录/账户权限。
- 不提交密钥、`.env`、本地数据库、节点私有状态或真实数据截图。原生/节点测试使用明确协议替身和假 Key，不能当作真实模型联调。
- 使用 Node 24 与 npm。按改动选择最少足够的验证；没有新修改、失败或具体疑点不重复全量测试。交付如实说明实际检查和限制。

UI 的唯一运行 tokens 在 `packages/ui/src/tokens.css`；客户端/部署方向见 [ADR-0008](docs/engineering/adr-0008-client-surfaces.md)。原工作项 ID 与状态只在 [19](docs/development/19-work-items.md) 维护。
