# 19｜可领取工作项与团队分工

> D1 · 17 个工作包 × 6 项 = 102 个工作项。  
> **2026-09-26（UTC+8）逐项核对，E2b1。保留原 102 个编号与标题，新增实际状态、剩余范围和代码入口。工程检查与当前边界见 [21｜实现进度](21-implementation-status.md)。**  
> [计划入口](README.md) · [先后依赖](00-delivery-map.md) · [接口总表](18-data-api-catalog.md)

## 1. 使用方式

下面是开发文档索引，不是已经创建的 GitHub Issues，也不是实际人员排期。每项的详细输入、交付物和依赖见对应计划；本页不维护另一套互相竞争的规格。内部团队可按实际成员把条目建成 issue 或直接在 PR 引用。

角色代号：TL 技术整合，FE 前端，BE 服务与数据，RN 执行器/适配器，UX 设计，OPS 部署维护。一个人可以兼任，不预设公司有这些独立岗位。

认领时记录负责人、分支、前置项和当前障碍；本页维护逐项状态，21 维护本轮增量与工程记录，不把模拟能力算作原生适配完成。质量与使用效果仍由内部团队安排，不把领取清单变成产品中的业务审批表。

## 状态口径与本次核对

按原工作项完整定义记录：**已完成 2 项、部分实现 61 项、未实现 39 项，共 102 项**。这些工作项大小不同，不能将条目数换算为产品完成百分比。

“已完成”仅指对应条目的窄范围；“部分实现”必须同时阅读剩余内容。原生流程检查仍使用协议替身，真实模型生成未联调。M0—M4 是完整产品阶段，E0/E1a/E1b/E1c/E2a/E2b1 是实际代码批次，二者不互相替代。

本轮推进 **06-01 / 06-02 / 06-03 / 06-06** 的独立节点身份与目录摘要切片。**只有配对、心跳和实际 Git 摘要；没有团队 Run 派发，不把节点在线当作模型执行。11-03 临时协助尚未开始。** 后续依赖和选择见 [下一步交付](22-next-delivery.md)。

## 2. 工作项索引

| ID | 工作项 | 主职责 | 当前状态 | 实际范围与剩余工作 | 代码证据入口 |
| --- | --- | --- | --- | --- | --- |
| HX-DEV-01-01 | 技术建议落为实际工程基线与版本锁定 | TL | 部分实现 | React/Vite、Fastify、TypeScript 与锁文件已有；E2a 固定 Better Auth 1.7.6，经 IdentityPort 接入。正式存储适配、完整许可证与升级维护仍待收口。 | [工程](../../package.json) / [认证](../../packages/identity/src/index.ts) |
| HX-DEV-01-02 | Monorepo 骨架与开发入口 | BE/RN | 已完成 | 应用与共享包、环境样例、统一启动/构建/类型检查入口已建立；本项仅工程骨架，不包含独立 Runner。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-01-03 | HTTP、事件、节点与适配器公共契约 | TL/BE/RN | 部分实现 | 本机 HTTP、DTO、错误码、运行和接续契约已落地；远程节点协议、完整权限 schema 与类型生成未完成。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-01-04 | 迁移、事务、outbox 与附件存储端口 | BE | 部分实现 | SQLite 迁移 5、事务/outbox、账号隔离和节点注册/摘要 ACK 已落地；PostgreSQL、附件存储和旧数据导入仍未实现。 | [迁移](../../packages/db/src/schema.ts) / [节点](../../packages/db/src/nodes.ts) |
| HX-DEV-01-05 | 模拟适配器与统一演示数据 | RN/FE | 部分实现 | 虚构数据及成功/失败/输入/授权模拟流程已实现；节点失联、缺模型等完整场景集和生产隔离仍需完善。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-01-06 | 最小自托管开发组合与构建任务 | OPS/BE | 部分实现 | 本机构建、health/ready 与只读 CI 已有；正式数据库/文件服务的自托管组合与配置诊断未完整实现。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-02-01 | 设计变量、浅深色与状态 tokens | UX/FE | 部分实现 | 浅深色、颜色与状态变量已实现；字体、间距等仍有页面硬编码，完整语义 tokens 与使用说明未收口。 | [界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css) |
| HX-DEV-02-02 | 应用外壳、导航与空间切换 | FE | 部分实现 | 导航、项目入口及真实个人/团队空间切换已实现，切换清理旧页面缓存；完整工作偏好与其他入口仍待完善。 | [身份界面](../../apps/web/src/identity.tsx) / [外壳](../../apps/web/src/App.tsx) |
| HX-DEV-02-03 | 任务、执行、人物、工具、成果组件 | FE | 部分实现 | 任务、执行、人物/工具、成果组件已有；完整上下文引用与全部状态示例未完成。 | [界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css) |
| HX-DEV-02-04 | 四类核心页面的模拟交互 | UX/FE | 已完成 | 工作台、项目、任务和成果四类页面骨架已接统一示例数据并可交互；此完成状态仅指页面骨架。 | [界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css) |
| HX-DEV-02-05 | 继续、协助、并行与反馈面板 | UX/FE | 部分实现 | 继续、反馈与回复界面已有，E1c 增加接续状态卡；协助和并行面板未实现。 | [界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css) |
| HX-DEV-02-06 | 响应式、键盘、文案与异常状态 | FE | 部分实现 | 窄屏、浅深色、搜索/弹层键盘路径及部分异常状态已有；布局偏好、历史阅读保护与完整文案字典未完成。 | [界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css) |
| HX-DEV-03-01 | 认证组件、登录与会话恢复 | BE/FE | 部分实现 | Better Auth 真实密码账号、初始化代码、登录/退出、改密、会话恢复及撤销已实现；邮件验证、忘记密码恢复、SSO 和正式部署未接入。 | [认证](../../packages/identity/src/index.ts) / [界面](../../apps/web/src/identity.tsx) |
| HX-DEV-03-02 | 空间、成员与邀请 | BE/FE | 部分实现 | 真实个人/团队空间、绑定邮箱的邀请、接受/撤销/过期与成员退出/移除已有；无邮件发送、完整空间角色管理与所有者转移。 | [协作数据](../../packages/db/src/collaboration.ts) / [空间](../../apps/web/src/team.tsx) |
| HX-DEV-03-03 | 统一访问策略与资源授权 | BE | 部分实现 | 统一 Task/Run/Result/Operation 和项目权限已实现；E2b1 节点凭证与浏览器会话分离，摘要按项目过滤。通用 AccessGrant、文件读取与任务派发的节点授权仍未实现。 | [权限](../../packages/db/src/permissions.ts) / [节点](../../packages/db/src/nodes.ts) |
| HX-DEV-03-04 | 项目、仓库引用与成员配置 | BE/FE | 部分实现 | 真实空间中的项目创建、读取、成员添加/移除及角色配置已实现；项目编辑/归档、仓库引用与完整目标配置尚缺。 | [项目成员](../../packages/db/src/collaboration.ts) / [界面](../../apps/web/src/team.tsx) |
| HX-DEV-03-05 | 个人/团队渐进入门 | FE | 部分实现 | 建立首个账号后直接进入个人空间，可建团队、邀请和加入，真实界面已有；独立节点连接与完整渐进入门偏好未实现。 | [身份](../../apps/web/src/identity.tsx) / [空间](../../apps/web/src/team.tsx) |
| HX-DEV-03-06 | 成员撤销、归档与权限事件 | BE | 部分实现 | 成员、项目和会话撤销已有；节点及待配对码随所有者项目撤权永久失效，重新加回成员不复活旧凭证。项目归档和活动远程执行的撤销联动未实现。 | [撤销触发器](../../packages/db/src/schema.ts) |
| HX-DEV-04-01 | Task 基础、归属和修订 | BE | 部分实现 | Task 修订、创建者归属和真实个人/项目访问范围已有；改派、参与者及正式存储的完整模型尚缺。 | [任务](../../packages/db/src/store.ts) |
| HX-DEV-04-02 | 完成、重开、取消与活动执行联动 | BE/FE | 部分实现 | 完成/重开/取消及活动执行后端联动已有，团队编辑权限已校验；完整动作 UI 与远程执行联动仍待收口。 | [任务](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx) |
| HX-DEV-04-03 | 列表、看板、排序、筛选与等待原因 | FE/BE | 部分实现 | 列表、看板、关键词查找和等待原因展示已有；完整排序与成员/等待原因组合筛选未完成。 | [任务](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx) |
| HX-DEV-04-04 | 可选需求说明、修订与局部采用 | FE/BE | 未实现 | 可编辑 Task 说明不等于独立需求模型；Requirement 修订和局部采用未实现。 | —（尚无可用实现） |
| HX-DEV-04-05 | 子任务、依赖、标签与里程碑 | BE/FE | 未实现 | 子任务、依赖、可维护标签和里程碑未实现。 | —（尚无可用实现） |
| HX-DEV-04-06 | 项目/个人入口与 Task DTO 统一 | BE/FE | 部分实现 | 真实项目/个人 Task 共用 DTO、创建和权限；跨空间选择性转移与完整归属切换未完成。 | [任务](../../packages/db/src/store.ts) |
| HX-DEV-05-01 | 线程、消息、提及与附件关联 | BE/FE | 部分实现 | 任务消息和成果回复已持久化；线程、提及及附件关联未完成。 | [消息](../../packages/db/src/store.ts) / [上下文](../../apps/runner/src/runtime.ts) |
| HX-DEV-05-02 | 项目资料、修订与来源 | BE/FE | 未实现 | 项目资料独立模型、资料修订和来源管理未实现。 | —（尚无可用实现） |
| HX-DEV-05-03 | 从讨论保存团队约定 | BE/FE | 未实现 | 从讨论保存共享团队约定未实现。 | —（尚无可用实现） |
| HX-DEV-05-04 | AI 草稿与局部编辑/采用 | FE/BE | 未实现 | AI 草稿及局部编辑/采用流程未实现。 | —（尚无可用实现） |
| HX-DEV-05-05 | 按权限与目的准备上下文 | BE/RN | 部分实现 | 任务说明、近期记录与有界 Git 摘录可装配；完整按权限/目的选材的 ContextBundle 未实现。 | [消息](../../packages/db/src/store.ts) / [上下文](../../apps/runner/src/runtime.ts) |
| HX-DEV-05-06 | 上下文面板、送达状态与总结接入 | FE/RN | 部分实现 | 可查看执行/接续上下文；运行中送达状态、项目资料引用与总结接入未实现。 | [消息](../../packages/db/src/store.ts) / [上下文](../../apps/runner/src/runtime.ts) |
| HX-DEV-06-01 | Runner CLI、配对与节点身份 | RN/BE | 部分实现 | E2b1 独立 CLI connect/start/status/disconnect、一次性配对、节点身份、私有凭证文件与注册已实现；仅回环服务和摘要能力，系统凭证存储、安装分发与正式远程连接未完成。 | [CLI](../../apps/runner/src/cli.ts) / [节点协议](../../apps/control/src/nodes.ts) |
| HX-DEV-06-02 | 主动连接、心跳、spool 与重放 | RN/BE | 部分实现 | E2b1 独立进程主动 HTTP 连接、代次、心跳、有界本地摘要 spool、落盘 ACK 和断线重放已实现；WSS、命令派发/接受 ACK、Run 事件 spool 和远程重连尚未实现。 | [连接](../../apps/runner/src/agent/connection.ts) / [spool](../../apps/runner/src/agent/storage.ts) |
| HX-DEV-06-03 | 目录权限、WorkingCopy 与 Git 状态 | RN | 部分实现 | 既有 preview Git 状态/diff 保留；E2b1 在节点本地规范化目录、拒绝重叠、绑定目录身份并分享实际数量摘要。节点文件/diff 读取授权、代码 WorkingCopy 派发与跨平台覆盖未完成。 | [节点目录](../../apps/runner/src/agent/workspaces.ts) / [原现场](../../apps/runner/src/workspaces.ts) |
| HX-DEV-06-04 | 独立工作区、写入约束与资源登记 | RN/BE | 部分实现 | 本机写入互斥和接续预约已有；独立代码工作区/分支隔离与远程资源登记未实现。 | [现场](../../apps/runner/src/workspaces.ts) / [进程](../../apps/runner/src/process-host.ts) |
| HX-DEV-06-05 | 进程树、输入输出与取消 | RN | 部分实现 | POSIX 进程组、输出与有界取消已有；原生运行中输入、Windows 和跨平台实测未完成。 | [现场](../../apps/runner/src/workspaces.ts) / [进程](../../apps/runner/src/process-host.ts) |
| HX-DEV-06-06 | 重启对账、能力发现与诊断 | RN | 部分实现 | E2b1 区分在线/陈旧/离线/待确认，节点重启重放摘要、服务重启重新握手、status 不伪报在线；没有 Run 对账、原生工具探测、安装升级或全平台诊断。 | [连接](../../apps/runner/src/agent/connection.ts) / [节点界面](../../apps/web/src/nodes.tsx) |
| HX-DEV-07-01 | Run、配置快照和状态 reducer | BE/RN | 部分实现 | Run、配置快照、状态规则已有；主执行/协助/并行的完整统一模型未完成。 | [状态/事务](../../packages/db/src/store.ts) / [接口](../../apps/control/src/app.ts) |
| HX-DEV-07-02 | 持久化派发、ACK 与幂等 | BE/RN | 部分实现 | 既有本机幂等派发和接续原子关联保留；E2b1 ACK 仅针对目录摘要，不计作团队 Run 派发完成。独立节点命令派发、接受 ACK 和执行去重尚未实现。 | [本机 Run](../../packages/db/src/store.ts) / [摘要协议](../../packages/db/src/nodes.ts) |
| HX-DEV-07-03 | 归一化事件、游标和权限 SSE | BE/FE | 部分实现 | 本机事件、游标和 SSE 已接真实会话/空间/项目权限，会话与成员撤销会断流；独立节点远程事件通道未完成。 | [事件](../../apps/control/src/app.ts) |
| HX-DEV-07-04 | 运行输入与下一轮队列 | BE/RN | 部分实现 | 模拟输入/授权回复可用；原生运行中输入与下一轮要求队列未实现，接续队列不是输入队列。 | [状态/事务](../../packages/db/src/store.ts) / [接口](../../apps/control/src/app.ts) |
| HX-DEV-07-05 | 绑定式动作授权与真实拒绝 | BE/RN | 部分实现 | 模拟授权与原生额外请求默认拒绝已有；真实动作绑定授权问答尚未实现。 | [状态/事务](../../packages/db/src/store.ts) / [接口](../../apps/control/src/app.ts) |
| HX-DEV-07-06 | 停止、取消、竞争与恢复 | RN/BE | 部分实现 | 本机停止、目录互斥、未知状态保锁及接续取消竞态已有；跨节点停止/恢复与平台覆盖未完成。 | [状态/事务](../../packages/db/src/store.ts) / [接口](../../apps/control/src/app.ts) |
| HX-DEV-08-01 | Claude 路径、账号方式与能力声明 | RN | 部分实现 | CLI 路径、必要参数探测和独立 API 配置已有；其他账号方式与有效账户联调未完成。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-08-02 | Claude 启动与结构化流 | RN | 部分实现 | 受限 CLI 启动和 JSONL 结构流已实现；实际提供方生成尚未联调，流程检查使用协议替身。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-08-03 | Claude 原生会话与恢复映射 | RN | 部分实现 | 原生 session 引用已记录；同工具 resume/恢复映射未实现。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-08-04 | Claude 输入、澄清与权限桥接 | RN | 未实现 | 原生运行中输入、澄清和完整权限桥接未实现；默认拒绝额外请求不算完成。 | —（尚无可用实现） |
| HX-DEV-08-05 | Claude 中断与失败降级 | RN | 部分实现 | 实际进程停止、超时与错误保留已有；完整提供方失败降级与跨平台恢复未完成。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-08-06 | Claude 用量、结果与资源配置 | RN/FE | 部分实现 | 原生结果、用量来源及本机预算配置已有；真实费用核对、完整资源配置与账户能力未验证。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-09-01 | Codex stdio、握手与版本能力 | RN | 部分实现 | 本机 stdio、握手与能力探测已有，既有官方无模型检查有记录；完整版本兼容矩阵未完成。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-02 | Codex thread/turn 与引用 | RN | 部分实现 | 新 thread/turn 和引用隔离已实现；原生会话恢复未实现。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-03 | Codex 事件、增量和结果映射 | RN | 部分实现 | 事件、增量、结果和异常映射已有；真实提供方生成未联调。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-04 | Codex 模型目录、输入与反向请求 | RN | 部分实现 | 模型目录与额外反向请求拒绝已有；实时输入、steer 与完整授权交互未实现。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-05 | Codex 中断、重连与对账 | RN | 部分实现 | 中断、超时和本机未知状态处理已有；原生重连/恢复对账未完成。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-06 | Codex 用量、配置与限制展示 | RN/FE | 部分实现 | 用量来源、隔离配置和限制文案已有；真实计费及完整账户可用性未验证。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-10-01 | 任务页面与双状态头 | FE | 部分实现 | TaskDetail 双状态布局已接真实成员访问范围，只读成员禁用编辑；高级布局/共享范围功能仍待完善。 | [任务页面](../../apps/web/src/App.tsx) |
| HX-DEV-10-02 | 协作消息、事件与草稿 | FE | 部分实现 | 协作消息、本机事件和错误提示已有；历史分页、草稿恢复与完整发送状态未完成。 | [任务页面](../../apps/web/src/App.tsx) / [原生面板](../../apps/web/src/native.tsx) |
| HX-DEV-10-03 | 工具/模型/节点与运行控制 | FE/RN | 部分实现 | 双工具/模型、本机开始、停止和持久化接续已有；远程节点选择与原生运行输入未实现。 | [任务页面](../../apps/web/src/App.tsx) / [原生面板](../../apps/web/src/native.tsx) |
| HX-DEV-10-04 | 文件、diff 与外部 IDE | FE/RN | 部分实现 | 实际 Git 文件差异已有；完整文件树、不可变成果快照和外部 IDE 衔接未实现。 | [任务页面](../../apps/web/src/App.tsx) / [原生面板](../../apps/web/src/native.tsx) |
| HX-DEV-10-05 | 受控交互终端与输入权 | FE/RN | 未实现 | 带输入权的受控交互终端、重连和会话清理未实现。 | —（尚无可用实现） |
| HX-DEV-10-06 | 上下文、协助、成果插槽整合 | FE | 部分实现 | 上下文与成果插槽、接续恢复卡已有；协助卡和完整多面板异常状态未完成。 | [任务页面](../../apps/web/src/App.tsx) / [原生面板](../../apps/web/src/native.tsx) |
| HX-DEV-11-01 | 继续命令与针对性预检 | BE/RN | 部分实现 | E1c 新增 202 Operation、预检原因、幂等、刷新查询和本机预约；完整共享上下文选择及真实权限未实现。 | [Operation](../../packages/db/src/continuations.ts) / [协调器](../../apps/runner/src/continuations.ts) / [界面](../../apps/web/src/continuations.tsx) |
| HX-DEV-11-02 | 同机接续、停止后继续与重开 | RN/BE | 部分实现 | E1c 新增等待/请求停止后自动接续、原子 Run 关联和取消保护；原生 resume、跨节点和真实模型联调仍缺。 | [Operation](../../packages/db/src/continuations.ts) / [协调器](../../apps/runner/src/continuations.ts) / [界面](../../apps/web/src/continuations.tsx) |
| HX-DEV-11-03 | Assistance、所选快照与有限访问 | BE | 未实现 | Assistance、固定协助快照与有限 AccessGrant 未实现；依赖 03 的真实权限基础。 | —（尚无可用实现） |
| HX-DEV-11-04 | 真人回应与 AI 协助 Run | BE/RN | 未实现 | 真人协助回复、AI assist Run 和独立只读/隔离协助流程未实现。 | —（尚无可用实现） |
| HX-DEV-11-05 | 继续/协助抽屉与就地回复 | FE | 部分实现 | E1c 继续抽屉、处理原执行选项和持久化进度卡已实现；协助抽屉与就地回应未实现。 | [Operation](../../packages/db/src/continuations.ts) / [协调器](../../apps/runner/src/continuations.ts) / [界面](../../apps/web/src/continuations.tsx) |
| HX-DEV-11-06 | 采纳、追问、取消与恢复 | FE/BE | 未实现 | 协助的采纳/追问/取消与旧快照提示未实现；本轮接续取消不冒充协助工作项完成。 | —（尚无可用实现） |
| HX-DEV-12-01 | 多仓库提交/补丁检查点 | RN | 未实现 | 多仓库不可变检查点与补丁封装未实现；当前 Git 摘录不是可恢复检查点。 | —（尚无可用实现） |
| HX-DEV-12-02 | 检查点传输与目标恢复 | RN/BE | 未实现 | 检查点传输和目标机器恢复未实现。 | —（尚无可用实现） |
| HX-DEV-12-03 | Handoff 发布、接受与状态 | BE | 未实现 | Handoff 发布、接受与生命周期未实现。 | —（尚无可用实现） |
| HX-DEV-12-04 | 选择性分享和跨空间明确发布 | BE/FE | 未实现 | 选择性分享与跨空间明确发布未实现。 | —（尚无可用实现） |
| HX-DEV-12-05 | 接手卡与责任可选转移 | FE | 未实现 | 跨成员接手卡及可选责任转移未实现。 | —（尚无可用实现） |
| HX-DEV-12-06 | 接手刷新恢复与部分失败处理 | RN/BE | 未实现 | 接手刷新恢复和部分失败处理未实现。 | —（尚无可用实现） |
| HX-DEV-13-01 | WorkBranch 与共同起点 | BE | 未实现 | WorkBranch 与共同起点模型未实现。 | —（尚无可用实现） |
| HX-DEV-13-02 | 分支独立现场与并发执行 | RN/BE | 未实现 | 分支独立现场和并发代码执行未实现。 | —（尚无可用实现） |
| HX-DEV-13-03 | 分支成果绑定与部分失败 | BE | 未实现 | 分支成果绑定与部分失败处理未实现。 | —（尚无可用实现） |
| HX-DEV-13-04 | 方案对比与选择继续 | FE/BE | 未实现 | 方案对比和选择某分支继续未实现。 | —（尚无可用实现） |
| HX-DEV-13-05 | 固定版本的选择性整合 | RN/BE | 未实现 | 固定版本的选择性代码整合未实现。 | —（尚无可用实现） |
| HX-DEV-13-06 | 分支停止、丢弃与清理保护 | RN/FE | 未实现 | 分支停止、丢弃与清理保护未实现。 | —（尚无可用实现） |
| HX-DEV-14-01 | Result/Revision 与基础产物 | BE | 部分实现 | 基础 Result、文字成果和来源关联已有；不可变 Revision 与完整产物模型未实现。 | [成果](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx) |
| HX-DEV-14-02 | 成果卡、版本与说明编辑 | FE | 部分实现 | 成果卡、页面和创建说明已有；版本历史与成果说明修订编辑未完成。 | [成果](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx) |
| HX-DEV-14-03 | 预览会话与主动隧道 | RN/BE | 未实现 | 通用预览会话与主动隧道未实现；订单示例页不是用户项目预览。 | —（尚无可用实现） |
| HX-DEV-14-04 | 预览独立身份与失效回退 | BE/FE | 未实现 | 独立预览身份、授权失效与真实预览回退未实现。 | —（尚无可用实现） |
| HX-DEV-14-05 | 版本反馈、回复与后续任务 | FE/BE | 部分实现 | 成果评论与回复已持久化；固定版本反馈和由反馈生成后续任务未完成。 | [成果](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx) |
| HX-DEV-14-06 | 可选报告、发布引用与完成整合 | FE/BE | 未实现 | 可选报告、发布引用与成果完成整合未实现；无需报告即可完成任务已在 04 范围实现。 | —（尚无可用实现） |
| HX-DEV-15-01 | 我的工作和项目概览查询 | BE | 部分实现 | 工作台和项目聚合按真实主体/空间/项目权限过滤；完整团队汇总与协助/接手查询仍缺。 | [工作台](../../packages/db/src/store.ts) |
| HX-DEV-15-02 | 工作台、待回复与成果视图 | FE | 部分实现 | 工作台、等待提示和成果视图已有；真实协助/接手待回复聚合未完成。 | [查询](../../apps/control/src/app.ts) / [工作台](../../apps/web/src/App.tsx) |
| HX-DEV-15-03 | 通知投影、去重与偏好 | BE/FE | 未实现 | 通知投影、去重和个人偏好未实现。 | —（尚无可用实现） |
| HX-DEV-15-04 | 有权限的中文关键词搜索 | BE/FE | 部分实现 | 任务中文关键词搜索按真实会话/项目和私有任务权限过滤；跨资料、成果等实体搜索未完成。 | [查询](../../apps/control/src/app.ts) |
| HX-DEV-15-05 | 用量去重、费用来源与预算提示 | BE | 部分实现 | 原生用量事件和费用来源说明已有；计量账本、统一去重聚合和预算提示未完成。 | [查询](../../apps/control/src/app.ts) / [工作台](../../apps/web/src/App.tsx) |
| HX-DEV-15-06 | 费用、成员工作与陈旧状态 UI | FE | 未实现 | 完整费用面板、真实成员工作与统一陈旧状态界面未实现；示例成员和局部 Run 状态不算完成。 | —（尚无可用实现） |
| HX-DEV-16-01 | 模板、版本与步骤编辑 | BE/FE | 未实现 | 协作模板、版本和步骤编辑未实现。 | —（尚无可用实现） |
| HX-DEV-16-02 | 实例调度与普通 Run 复用 | BE/RN | 未实现 | 模板实例调度和普通 Run 复用未实现。 | —（尚无可用实现） |
| HX-DEV-16-03 | 实例继续、跳过与取消联动 | BE/FE | 未实现 | 模板实例继续、跳过与取消未实现。 | —（尚无可用实现） |
| HX-DEV-16-04 | 连接器、外部引用与首个 Git/PR 接入 | BE | 未实现 | 外部连接器、引用及 Git/PR 产品集成未实现；开发仓库托管在 GitHub 不算产品集成。 | —（尚无可用实现） |
| HX-DEV-16-05 | Webhook、去重与可选自动完成 | BE | 未实现 | 外部 Webhook、去重与可选自动完成未实现。 | —（尚无可用实现） |
| HX-DEV-16-06 | 可选 CI/发布/通知与连接状态 | BE/FE | 未实现 | 可选 CI/发布/通知产品集成未实现；开发 CI 不算产品业务功能。 | —（尚无可用实现） |
| HX-DEV-17-01 | 自托管安装、HTTPS 与初始化 | OPS/BE | 未实现 | 面向团队的自托管安装、HTTPS 和初始化未实现；本机启动不是公网部署。 | —（尚无可用实现） |
| HX-DEV-17-02 | 团队远程节点与受控环境 | RN/OPS | 未实现 | 团队远程节点和受控运行环境未实现。 | —（尚无可用实现） |
| HX-DEV-17-03 | 预览、端口、临时资源与清理 | RN/OPS | 未实现 | 远程预览、端口与临时资源治理未实现。 | —（尚无可用实现） |
| HX-DEV-17-04 | Runner 分发、升级与回退 | RN/OPS | 未实现 | Runner 分发、升级与回退未实现。 | —（尚无可用实现） |
| HX-DEV-17-05 | 备份恢复、迁移和状态对账 | BE/OPS | 未实现 | 正式备份恢复、生产迁移和多节点对账未实现；本地 SQLite 迁移归属 01。 | —（尚无可用实现） |
| HX-DEV-17-06 | 维护诊断、脱敏导出与保留策略 | FE/BE/OPS | 未实现 | 运维诊断、脱敏导出与保留策略未实现。 | —（尚无可用实现） |

## 3. 每项领取时的最小上下文

```text
工作项：HX-DEV-11-02
目标：同机从 Claude Code 接续到 Codex，不重建任务。
输入：计划 11、公共契约 18、产品状态 05；已有 Run/WorkingCopy 接口。
改动范围：continuation service、runner bridge、任务继续动作。
前置：11-01，06 的工作区与停止，08/09 的有效适配能力。
交付：新 Run 关联前驱、沿用现场、上下文来源、停止未确认时的明确反馈。
不做：跨节点完整迁移、正式交接审批、自动判定代码合格。
说明：列出真实接通和模拟部分、基本运行方式、尚缺配置。
```

实际认领附负责人和分支，内容变更同步对应计划。避免把整套几十页文档不加筛选地发给所有 Agent，造成无关上下文和互相修改公共模型。

## 4. 整合规则

公共契约、数据库迁移和设计 tokens 由明确的人协调；不同任务使用独立分支和工作区。需要改其他包接口时说明消费方与兼容方式，先对齐 schema，再各自实现。

一个工作项可以拆成多个小 PR，也可以将强相关条目组合，但引用原 ID，不能把演示页面和真实执行混报为同一完成状态。基本运行说明和必要回归由开发负责，公司的评估方式不写进产品用户流程。

详细依赖以 00 和各计划为准，不按编号机械串行。E0—E1c 的本机工具预览保留；E2a 新增独立的真实账号与协作数据模式。E2b1 已有独立节点身份与目录摘要，下一组补任务派发/执行确认与正式存储，不让团队账号继承宿主机权限。

## 批次记录

E1a 推进本机目录/Git/进程与 Claude；E1b 推进 Codex 和显式跨工具继续；E1c 推进持久化接续、等待/停止、刷新、取消与重启保护。历史工程结果在 Git 历史与 21 中保留。所有状态以原条目完整范围为依据，不以本轮新增按钮数或测试数代表完成。

E2a 推进真实账号、个人/团队空间、邀请、项目角色与访问撤销。03-01/02/05/06 从未实现调整为部分实现；保留原工作项完整范围和未完成内容。

E2b1 将 06-01/02 从未实现调整为部分实现；03-03/06 和 06-03/06 增补实际范围，07-02 明确目录摘要 ACK 不是 Run 接单。
