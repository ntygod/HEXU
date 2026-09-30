# 使用与工程指南

这里说明当前功能怎样使用、限制在哪里。最新交付事实和验证只在 [21](../development/21-implementation-status.md) 汇总；维护代码时另选 [harness](../harness/README.md)。

## 启动与执行

| 需要 | 指南 |
| --- | --- |
| 默认示例模式、数据、端口与排错 | [本地启动](local-preview.md) |
| 本机真实账号、个人/团队空间、邀请 | [team-local](team-local.md) |
| preview 配置 Claude/Codex | [原生执行](native-execution.md) |
| 配对、摘要、连接与撤销 | [独立节点](runner-node.md) |
| 单独授权本人节点执行/停止 | [节点执行](runner-execution.md) |
| 下一轮要求、等待/停止后继续 | [节点接续](node-continuation.md) |
| 私有历史保留与显式恢复 | [Claude](claude-sessions.md)、[Codex](codex-sessions.md) |

## 项目、内容与协作

| 需要 | 指南 |
| --- | --- |
| 项目名称/说明与角色 | [项目设置入口](team-local.md#项目基本设置与修订) |
| 归档/恢复及运行影响 | [项目归档](project-archive.md) |
| 改派与参与者/筛选 | [负责人](task-assignment.md)、[参与](task-participants.md) |
| 文本/链接资料、版本与删除恢复 | [项目资料](project-sources.md) |
| 从讨论明确发布/替代约定 | [项目约定](project-agreements.md) |
| 执行选材、预算与固定输入 | [材料快照](project-materials.md) |
| AI 回复整理与片段采用 | [AI 草稿](ai-drafts.md) |
| 请同事或 AI 分析固定片段 | [真人协助](human-assistance.md)、[AI 文本协助](ai-text-assistance.md) |
| 将已保存建议采用到原任务 | [协助建议采用](assistance-adoption.md) |
| 本机提交引用、另行确认的对象保留 | [提交检查点](commit-checkpoints.md)、[对象保留](checkpoint-retention.md) |
| 只读检查新目录恢复材料，不实际写入 | [恢复预检](checkpoint-restore-plan.md) |
| 本机暂存写入、不覆盖发布与明确清理 | [新目录恢复](checkpoint-restore.md) |
| 明确报告恢复结果、任务内历史与丢失回执对账 | [恢复结果](checkpoint-restore-results.md) |
| 同项目双节点明确收发固定对象 | [受控传输](checkpoint-transfer.md) |
| 接收者用自己的副本恢复与报告 | [接收端恢复](checkpoint-received-restore.md) |
| 发布、拒绝、撤回接手邀请 | [任务接手邀请](handoff-invitations.md) |
| 本机新核验、接受接手与操作者/可选负责人 | [接受接手](handoff-acceptance.md) |
| 接手目录准备 Git、本人配对与新 Run | [接手现场研发](handoff-workspace.md) |
| 同一 Task 的共同起点、方案定义与放弃 | [方案分支](work-branches.md) |
| 方案独立目录、登记、本人首轮 Run 与并发 | [方案现场](branch-workspaces.md) |
| 已结算方案Run的只读来源、共享输出与事件边界 | [成果来源预览](branch-result-sources.md) |
| 固定成果版本、来源/反馈、方案比较与选择 | [方案成果](branch-results.md) |
| 方案成果关联固定提交、对象状态与节点共享差异 | [固定代码](result-code.md) |
| 选定成果后，在原目录明确开始下一轮 | [方案接续](branch-continuation.md) |
| 固定成果到本人目标提交的只读冲突检查 | [整合预检](integration-preflight.md) |
| 本人确认选择新增普通文件、持久写锁与中断证据 | [整合应用](integration-application.md) |
| 明确停止旧应用及子进程后，保留全部文件并结算原占用 | [本机结算](integration-recovery.md) |
| 原已完成应用的全部文件，从精确原备份另行确认恢复 | [原应用文件恢复](integration-file-restoration.md) |
| 选中新增/修改/删除，在新私有目录核对完整候选文件 | [独立目录试应用](integration-trial.md) |
| 本机核对候选差异，另行共享并在Task查看不可变历史 | [候选差异](integration-trial-differences.md) |

## 架构决策

ADR 保存作出决定时的背景与约束；其中的阶段进度不覆盖 21。现行客户端形态由 ADR-0008 规定，桌面框架与安装分发仍未决定/交付。

| 决策 | 主题 |
| --- | --- |
| [ADR-0001](adr-0001-local-preview.md) | 本地预览与阶段性存储 |
| [ADR-0002](adr-0002-local-native-runtime.md) | 本机受限原生 runtime |
| [ADR-0003](adr-0003-codex-continuation.md) | Codex 与同机接续 |
| [ADR-0004](adr-0004-durable-continuation.md) | 持久化 Operation |
| [ADR-0005](adr-0005-local-identities.md) | 本机真实身份 |
| [ADR-0006：节点](adr-0006-node-metadata.md) | 摘要配对与节点凭证 |
| [ADR-0006：会话](adr-0006-codex-session-retention.md) | Codex 私有历史；与同号节点文档独立，按文件名引用 |
| [ADR-0007](adr-0007-node-execution.md) | 本人节点执行 |
| [ADR-0008](adr-0008-client-surfaces.md) | 桌面优先、可选团队服务与 Web |

依赖与许可证见 [dependencies](dependencies.md)；团队如何评估产品/质量见 [内部评估边界](internal-evaluation.md)，不把它变成用户完成任务的必经流程。
