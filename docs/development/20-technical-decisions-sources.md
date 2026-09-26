# 20｜技术建议、未定项与官方依据

> D1 · 2026-09-25 · 将工程建议、产品决定和外部事实分开。  
> [计划入口](README.md) · [产品决策](../product/08-decisions-risks-and-sources.md)

## 1. 已继承的产品边界

v1.1 已明确轻管理、深协作、成果直观；默认待处理/进行中/已完成；继续、协助、并行；本地与可选远程；团队自定质量评估。开发计划不得再要求创建任务前填写验收表，或在后端完成接口中查询强制证据。

D1 初次规划读取的历史基线为 `b4efad93076223475f9410e0b1e64708aaf40fcc`。2026-09-26 已有 E2c1 应用；当前范围见 [21](21-implementation-status.md)。[Workbench W1](../design/README.md) 和 [ADR-0008](../engineering/adr-0008-client-surfaces.md) 分别固定设计语言与客户端形态，不应再把以下旧建议当作未实施的空白项目。

## 2. 工程决策草案

| ID | 建议 | 当前状态与影响 |
| --- | --- | --- |
| DD-01 | TypeScript monorepo；React/Vite；Fastify；Node 24；npm；分模式 SQLite | 已采用，版本以锁文件为准；正式 PostgreSQL 仍待实现 |
| DD-02 | 模块化单体、SQL 事务+outbox；浏览器 HTTP/SSE，节点主动 WSS | 建议基线；优先降低多套调度与状态同步成本 |
| DD-03 | 身份复用成熟认证组件，经 IdentityPort 隔离 | 已采用 Better Auth 1.7.6；邮件恢复、正式部署等仍待实现 |
| DD-04 | Claude 采用显式受限 CLI；Codex 采用 App Server 本地 stdio | 当前实现不使用隐藏 SDK／订阅回退；能力、协议替身与有效账户联调分开记录，不能按旧“SDK 优先”草案重写现有适配 |
| DD-05 | 模型由适配器/配置发现，不在产品写死型号或永久分工 | 继承产品要求；工具不支持的能力要显式降级 |
| DD-06 | 独立预览 origin、短期授权、节点主动隧道 | 实现建议；没有相应部署条件时提供文件/diff，而非公开任意端口 |
| DD-07 | 同空间选择性共享可保留 Task ID；跨空间明确发布团队副本，不迁移所有私人历史 | 新增工程建议；界面必须说明新副本与来源，不建立双向同步任务库。若改为同 ID 跨空间迁移，需先重设计作用域与保留方案 |
| DD-08 | Workbench W1 暗色青色任务工作台；Figma 求助／交接信息结构选择性采用 | 设计基线已确认，tokens 与参考已归档；应用迁移未完成，演示不定义生产能力 |
| DD-09 | 具体语言/组件版本、首批 OS、Git 平台、部署容量及模型付费主体由团队采用时记录 | 不阻碍先写契约和页面，不编造公司基础设施与人力 |
| DD-10 | 桌面优先，可选团队服务，保留 Web 协作入口；共用 UI／契约／领域 | 产品形态按 ADR-0008 已决定；Electron／Tauri、安装升级、Windows 原生支持仍未定或未实现 |

已采用基线和已确认产品决定按对应权威文档维护；尚未选定的实现细节可根据具体任务选择并记录依据。这不是新的强制审批表，不能让不同包同时采用互不兼容的默认值。

## 3. 原生文档的使用方式

下列官方页面于本次规划中查阅，用来确认原生接口与限制。它们不证明 HEXU 已接入，未来接口仍以锁定版本为准。计划中的 RunSpec、ActionAuthorization、Operation 等是 HEXU 自定义契约，不是官方同名 API。

### S01

[Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

核对用途：SDK 与 Claude Code 的工具、循环和上下文能力；可编程语言及认证说明。08 的 SDK 建议不意味着可将个人订阅集中共享，实际认证按所采用路径处理。

### S02

[Run Claude Code programmatically](https://code.claude.com/docs/en/headless)

核对用途：程序化 CLI、结构化输出与会话继续。CLI 为兼容路径时，只展示实际支持的输入、授权和恢复能力，不解析终端装饰文本来推断状态。

### S03

[Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

核对用途：权限模式、规则、Hooks 和回调的顺序；自动允许的操作可能不经过交互回调。08 不能把 canUseTool 是否注册等同所有命令已经受控。

### S04

[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) · [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)

核对用途：输入模式与运行中交互的区别，权限与澄清问题的处理。HEXU 要表示真实送达状态，不能把下一轮排队显示成原生工具已经执行。

### S05

[Codex App Server](https://developers.openai.com/codex/app-server)；本次读取入口跳转到 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

核对用途：stdio、初始化、thread/turn/item、start/resume/steer/interrupt、模型目录与授权交互；部分字段需要实验能力。09 中只引用必要方法，不采用示例模型名作为固定默认。

### S06

[Git worktree](https://git-scm.com/docs/git-worktree)

核对用途：一仓库多个工作树与分支现场。06/13 复用这一能力，但目录独立不等于进程、网络、凭证和数据库都已隔离。

### S07

[Vite Getting Started](https://vite.dev/guide/)

核对用途：React/TypeScript 等项目起步方式。选 Vite 是本计划对内部 Web 工作台的建议，不是官方声称 HEXU 必须采用它。

### S08

[Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)

核对用途：请求/响应 schema 的工程入口。01/18 要求运行时契约；这里的 validation 是 API 输入校验，不是重新建设产品质量验证系统。

## 4. 范围、许可与资料处理

本次没有复制第三方源码或商标资产，没有选择 HEXU 软件许可证。后续复用组件按实际依赖记录许可与归属。不要仅因仓库公开就推定所有代码可任意重用，也不把原型图里的第三方 Logo 当作已清理的设计资产。

公开文档只放虚构示例和通用工程边界；内部评价、员工信息、客户仓库、凭证与生产部署值不进入此仓库。需要真实接入时由团队在自己的运行环境配置，不要求把秘密写回计划。

## 5. 如何更新这套计划

产品行为变化同步 product 01/03/05；数据和接口变更同步 development 01/18；页面变更遵循 W1 并同步 02/10/14；客户端职责变化同步 ADR-0008。保留原 102 项 ID，真实状态维护于 19，不按本文件的历史草案重置进度。

后续不要将“写了计划”“有演示图”“模拟器显示正常”报告为真实能力已经完成。基本工程自检照常，内部团队如何评价和上线由其自行安排。
