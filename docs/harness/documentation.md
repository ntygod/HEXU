# 文档治理 harness

> 按需读取：新增/调整 README、AGENTS、专题指南、状态、计划或架构决策。文档改动不自动扩大产品范围。

## 唯一归属

| 信息 | 写在哪里 | 不重复放在哪里 |
| --- | --- | --- |
| 定位、最短启动和主要入口 | [根 README](../../README.md) | 不逐次追加每个功能手册/CI 日志 |
| 全仓稳定原则与任务路由 | [根 AGENTS](../../AGENTS.md) | 不积累批次细节、版本号和长测试记录 |
| 按领域执行的约束、代码/测试入口 | [专题 harness](README.md) | 不在每个主题复制全仓规则 |
| 当前能力、限制、最近实际验证 | [21](../development/21-implementation-status.md) | README/24 只链接，不同步整张表 |
| 原任务 ID、状态/依据/剩余范围 | [19](../development/19-work-items.md) | 不创建竞争总账或重编号 |
| 唯一下一项与范围 | [22](../development/22-next-delivery.md) | 不在每个功能说明维护下一项 |
| 接手过程 | [24](../development/24-ai-handoff.md) | 不重复各功能实现及历次 CI 数字 |
| 完整目标、行为、UI/架构决策 | [产品](../product/README.md)、[设计](../design/README.md)、[ADR](../engineering/README.md#架构决策) | 不把目标表写成已实现能力 |
| 当前操作方法、参数与限制 | [工程指南](../engineering/README.md) | 不让根 README 变成操作手册集合 |
| 失败/修正/提交/CI 等历史证据 | [实现历史](../development/history/2026-09-28-implementation.md) | 不作为当前任务的默认必读上下文 |
| 机器路径、临时端口/进程 | 忽略的 `.hexu/local-environment.md` | 不写成其他机器的安装前提 |

产品 v1.1 与已接受设计/ADR 决定目标；源码/契约和实际证据决定已交付事实。两者冲突时先核对用户本次要求与代码，不靠调整文案声称实现已完成。历史文档的命令只在对应时期成立。

## 渐进式披露规则

- 根 AGENTS 保持短路由；维护时以约一页、60 行以内为目标，确实增加全仓必要约束时再判断。细节放最接近行为的专题，不机械追加日志。
- 每份 harness 给出明确触发条件、实际入口、必须保留的语义与适用检查。只需改外观时不要求读取节点/账户协议；跨边界时补读对应指南。
- 普通链接需要显式打开，不假设会自动递归注入。这里使用仓库 Markdown 指南，不安装插件、不改全局模型配置或人为增加审批流程。
- 不重复要求通读所有文档、每次全量测试或为常规可逆动作申请批准。适用约束保持明确，验证按改动风险选择。
- 日期、测试数量和进度变化只更新其事实归属页。专题中的版本专例只在理解协议边界时保留，并链接实际代码/工程记录。

这符合 OpenAI 官方对 [AGENTS 发现/作用域](https://learn.chatgpt.com/docs/agent-configuration/agents-md) 和 [按任务读取、渐进式披露](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) 的说明。Codex 默认合并文档大小上限为 32 KiB；原根文件约 41 KB，因此本次采用短入口与明确路由，不通过调大全局上限掩盖内容膨胀。这是本仓库的组织方式，不要求其他工具自动识别 harness 文件名。

## 本次 AGENTS 迁移对应

| 原内容 | 现归属 |
| --- | --- |
| 工作方式、结构、命令 | 根入口 / [开发](development.md) |
| 产品、W1、客户端方向 | 根入口 / [UI](ui.md) / 产品与 ADR 原文；已完成的 W1 执行期命令退出当前指令 |
| Current implementation 与工具检测事实 | [21](../development/21-implementation-status.md) / 工程指南 / 实现历史 |
| E2a 身份 | [身份](identity.md) |
| 设置、归档、改派、参与 | [项目任务](projects-tasks.md) |
| 资料、约定、选材、AI 草稿 | [上下文](context.md) |
| Native execution boundaries | [执行](execution.md) |
| E2b1/E2b2 | [节点](nodes.md) |
| Durable continuation、E2b3/E2b4 | [接续](continuation.md) |
| E2c1/E2c2 工具专例 | [Codex](codex.md) / [Claude](claude.md) |
| 真人/AI 协助与明确采用 | [协助](assistance.md) |
| 本机提交引用与对象保留 | [检查点](checkpoints.md) |

业务不变量保留在专题，过期阶段叙述与已完成的一次性重建指令不继续充当当前命令。没有新增模型权限、平台支持或完成状态。

## 验证与维护

检查本地相对链接/锚点、根路由可达性、引用代码/测试是否存在、启动命令与 package.json/配置是否一致。移动文档须同步相对路径；既有工作项 ID、状态和历史证据不能丢失。历史旧路径确需更名时保留明确跳转，不能制造两份有效规格。

纯文档治理无需跑业务全套；如同时改了脚本、配置或行为，再按 [开发 harness](development.md) 验证。交付列出实际治理范围、已做检查与未核验的外部链接，不把链接检查宣称为功能回归。
