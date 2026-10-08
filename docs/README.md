# HEXU 文档导航

先选择要回答的问题，再进入对应文档。目标、已交付能力、开发约束和历史证据分别维护。

| 你的问题 | 入口 | 文档职责 |
| --- | --- | --- |
| HEXU 是什么，怎样本地启动？ | [仓库 README](../README.md) | 简介、最短启动、模式边界 |
| 当前实际能做什么？ | [实现进度 21](development/21-implementation-status.md) | 当前能力/限制与最近验证 |
| 完整目标是什么？ | [产品目录](product/README.md) | 产品 v1.1、工作旅程与领域语义 |
| UI/客户端应遵循什么？ | [Workbench W1](design/README.md)、[ADR-0008](engineering/adr-0008-client-surfaces.md) | 当前设计与客户端方向 |
| 具体功能怎样使用？ | [使用与工程指南](engineering/README.md) | 当前操作方法、配置与限制 |
| 接下来开发什么？ | [下一步 22](development/22-next-delivery.md) | 唯一下一交付范围 |
| 跨 Agent 协作怎样拆分和接手？ | [交付拆分 25](development/25-agent-collaboration-delivery.md) | 原工作项组合、七个切片、依赖与同步说明 |
| 某个原工作项完成到哪里？ | [工作清单 19](development/19-work-items.md) | 102 个原 ID、状态、依据、剩余 |
| AI/开发者怎样接手？ | [AGENTS](../AGENTS.md)、[接手指南 24](development/24-ai-handoff.md) | 根路由与接手步骤 |
| 这类修改有哪些不变量？ | [harness 目录](harness/README.md) | 按需加载的实现约束与验证入口 |
| 某次验证或决定为什么这样做？ | [实现历史](development/history/2026-09-28-implementation.md)、[工程 ADR](engineering/README.md#架构决策) | 当时的证据/取舍，不覆盖现状 |

## 使用规则

产品/设计文档定义目标与语义；源码、契约及 21 的验证记录说明实际交付。计划中的 API/表名不是运行能力，示例/模拟不是生产数据；历史中的“未实现/下一项”只表示当时情况。

维护者使用 [文档治理 harness](harness/documentation.md) 选择唯一归属；不要同时在 README、AGENTS、交接页复制一整份能力清单或 CI 日志。
