# 19｜原工作项状态总账

> D1：17 个工作包 × 6 项 = 102 个原工作项。保持原 ID、标题、状态/依据/剩余范围；不是 GitHub Issues 或人员排期。

## 1. 状态口径

2026-10-08：按下表 102 行核对为 **3项已完成、80项部分实现、19项未实现**。本次只重排交付和补充剩余范围，不改变任何行的状态；不同大小的工作项不能折算产品完成百分比。

此前整合记录（2026-10-07）：用户要求处理全部远端 PR 并清理已结束分支；本轮整合已验收的 PR56—74，包含此前独立的 PR59。PR73的14-06原三条条件与PR74的04-03持久排序子条件已有精确CI验收；03-01补充迟到响应隔离，原状态保持部分实现。合并候选的完整CI与远端处理结果以本轮整合PR补齐，历史提交与证据保留。用户明确选择将旧链25个草稿关闭归档并保留提交，不合入其中尚有问题52的文件/原生功能。不同工作项大小不能折算产品完成百分比。

当前能力与最近验证看 [21](21-implementation-status.md)，下一项只看 [22](22-next-delivery.md)，详细批次证据与旧状态叙述看 [实现历史](history/2026-09-28-implementation.md)。本页不重复 CI 日志。M0—M4 是产品目标阶段，E0—E2c2 是历史代码批次，不能互相替代。

每项详情与依赖在对应 [工作包](README.md)；修改时选择相关 [harness](../harness/README.md)。W1-01—09 已交付，原任务映射在 [23](23-workbench-rebuild.md)，不另计工作项或从零重启 UI。协议替身与真实模型联调分开记录。

2026-10-08 按[产品 10](../product/10-agent-collaboration-plan.md)重排为[25 的七个交付切片](25-agent-collaboration-delivery.md)：首个里程碑包含跨成员、真实远端、澄清和原 Agent 消费结果继续。下表 D2 说明只扩展原项的剩余范围，状态和已有证据保留；切片无独立完成总账，唯一下一项见 22。

角色仅表示职责：TL 技术整合、FE 前端、BE 服务与数据、RN 执行器/适配器、UX 设计、OPS 部署维护，不表示实际人数或 AI 员工等级。

## 2. 工作项索引

| ID | 工作项 | 主职责 | 当前状态 | 实际范围与剩余工作 | 代码证据入口 |
| --- | --- | --- | --- | --- | --- |
| HX-DEV-01-01 | 技术建议落为实际工程基线与版本锁定 | TL | 部分实现 | React/Vite、Fastify、TypeScript 与锁文件已有；E2a 固定 Better Auth 1.7.6，经 IdentityPort 接入。正式存储适配、完整许可证与升级维护仍待收口。 | [工程](../../package.json) / [认证](../../packages/identity/src/index.ts) |
| HX-DEV-01-02 | Monorepo 骨架与开发入口 | BE/RN | 已完成 | 应用与共享包、环境样例、统一启动/构建/类型检查入口已建立；本项仅工程骨架，不包含独立 Runner。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-01-03 | HTTP、事件、节点与适配器公共契约 | TL/BE/RN | 部分实现 | 已增加独立节点的有界执行策略/派发/事件契约与一次性启动许可；不是任意 RPC。远程 WSS、完整权限 schema 与类型生成仍缺。 D2 待实施：独立参与身份、端点/能力与跨入口公共契约，见[交付切片 1](25-agent-collaboration-delivery.md#slice-1)。 | [执行契约](../../packages/contracts/src/node-execution.ts) |
| HX-DEV-01-04 | 迁移、事务、outbox 与附件存储端口 | BE | 部分实现 | SQLite 迁移 8 增加节点接续 Operation 与任务/节点唯一预约；Run、派发、所选要求、Operation 关联和 outbox 原子提交。PostgreSQL、附件存储和旧数据导入仍未实现。 D2 待实施：协作身份/请求扩展沿用迁移、事务与 outbox，编号按实际合并分配，见[交付切片 1](25-agent-collaboration-delivery.md#slice-1)。 | [迁移](../../packages/db/src/schema.ts) / [派发](../../packages/db/src/node-execution.ts) |
| HX-DEV-01-05 | 模拟适配器与统一演示数据 | RN/FE | 部分实现 | 虚构数据及成功/失败/输入/授权模拟流程已实现；节点失联、缺模型等完整场景集和生产隔离仍需完善。 D2 待实施：协作协议替身、异常夹具与真实互操作分别记录，见[交付切片 7](25-agent-collaboration-delivery.md#slice-7)。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-01-06 | 最小自托管开发组合与构建任务 | OPS/BE | 部分实现 | 本机构建、health/ready 与只读 CI 已有；正式数据库/文件服务的自托管组合与配置诊断未完整实现。 D2 待实施：首条有限协作的最小部署与配置诊断，见[交付切片 5](25-agent-collaboration-delivery.md#slice-5)。 | [工程](../../package.json) / [迁移](../../packages/db/src/schema.ts) |
| HX-DEV-02-01 | 设计变量、浅深色与状态 tokens | UX/FE | 部分实现 | W1 语义 tokens 是 UI 包唯一运行来源，浅深色／紧凑舒适密度已接入全套页面，旧配色映射已删除；后续业务功能控件仍按原包补齐。 | [变量](../../packages/ui/src/tokens.css) / [外观](../../apps/web/src/appearance.tsx) |
| HX-DEV-02-02 | 应用外壳、导航与空间切换 | FE | 部分实现 | W1 顶栏、导航轨、项目导引栏、面包屑和命令入口已替换旧壳层；原路由和空间切换保留，导引栏偏好按身份／空间隔离。完整工作区布局偏好与正式个人客户端仍未交付。 | [新外壳](../../apps/web/src/shell.tsx) / [客户端决定](../engineering/adr-0008-client-surfaces.md) |
| HX-DEV-02-03 | 任务、执行、人物、工具、成果组件 | FE | 部分实现 | W1 共享控件、输入与配置面板、状态与抽屉已接入。旧全局页面样式删除并按功能归属；未交付业务对应控件不以演示补足。 | [控件](../../packages/ui/src/index.tsx) / [任务](../../apps/web/src/task-workspace.tsx) |
| HX-DEV-02-04 | 四类核心页面的模拟交互 | UX/FE | 已完成 | 工作台、项目、任务和成果四类页面骨架已接统一示例数据并可交互；此完成状态仅指页面骨架。 | [界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css) |
| HX-DEV-02-05 | 继续、协助、并行与反馈面板 | UX/FE | 部分实现 | 继续、反馈、接续状态界面已有；W1 归档交互参考并选用 Figma 求助材料／交接信息结构。真人有限材料与 Claude 纯文本 AI 协助已接入；完整代码协助、并行与接手仍未实现，参考按钮不计作功能交付。 D2 待实施：任务内协作选择、协商和结果回接状态，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [设计参考](../design/workbench-reference.html) / [界面](../../apps/web/src/App.tsx) |
| HX-DEV-02-06 | 响应式、键盘、文案与异常状态 | FE | 部分实现 | W1 已接浅深色／密度、按身份空间保存的布局偏好、键盘焦点、窄屏面板切换、草稿与历史阅读保护；完整业务文案字典及后续功能状态仍未收口。 D2 待实施：外部协作异常、输入保护与受影响布局，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [工作区](../../apps/web/src/task-workspace.tsx) / [浏览器检查](../../tests/e2e/workbench.spec.ts) |
| HX-DEV-03-01 | 认证组件、登录与会话恢复 | BE/FE | 部分实现 | Better Auth 真实密码账号、初始化代码、登录/退出、改密、会话恢复及撤销已实现；另补账号/空间变化后的旧拒绝通知隔离与身份查询排序及导航守卫，见[记录](history/2026-10-04-identity-late-response.md)。邮件验证、忘记密码恢复、SSO 和正式部署未接入。 D2 待实施：远端协作入口的实际认证子集，见[交付切片 5](25-agent-collaboration-delivery.md#slice-5)。 | [认证](../../packages/identity/src/index.ts) / [界面](../../apps/web/src/identity.tsx) |
| HX-DEV-03-02 | 空间、成员与邀请 | BE/FE | 部分实现 | 真实个人/团队空间、绑定邮箱的邀请、接受/撤销/过期与成员退出/移除已有；无邮件发送、完整空间角色管理与所有者转移。 | [协作数据](../../packages/db/src/collaboration.ts) / [空间](../../apps/web/src/team.tsx) |
| HX-DEV-03-03 | 统一访问策略与资源授权 | BE | 部分实现 | 统一真实项目/私有数据权限已有，节点本人执行权限与目录摘要可见性分离；指定他人执行、通用 AccessGrant、附件和远程授权仍未实现。 D2 待实施：Agent 稳定参与身份及发现/请求/材料/执行分离授权，见[交付切片 1](25-agent-collaboration-delivery.md#slice-1)。 | [权限](../../packages/db/src/permissions.ts) / [派发](../../packages/db/src/node-execution.ts) |
| HX-DEV-03-04 | 项目、仓库引用与成员配置 | BE/FE | 部分实现 | 真实项目创建/读取、成员和角色配置已有；新增管理者名称/说明编辑、修订冲突、历史分页与 W1 设置抽屉，保存/通知/幂等原子提交；归档/恢复与运行选择已接入；仓库引用与完整目标配置尚缺。 | [设置事务](../../packages/db/src/project-settings.ts) / [界面](../../apps/web/src/project-settings.tsx) / [回归](../../tests/project-settings.test.ts) |
| HX-DEV-03-05 | 个人/团队渐进入门 | FE | 部分实现 | 账号建立、团队创建/加入、节点配对与本人单独执行授权已有；完整渐进入门偏好和安装分发仍缺。 | [身份](../../apps/web/src/identity.tsx) / [空间](../../apps/web/src/team.tsx) |
| HX-DEV-03-06 | 成员撤销、归档与权限事件 | BE | 部分实现 | 成员、项目和会话撤销已有；节点及待配对码随所有者项目撤权永久失效，重新加回成员不复活旧凭证。新增管理者修订式归档/恢复、未许可取消、双类等待安排原子暂停、活动运行 keep/stop 和恢复不重放；同机权限/事件已覆盖，正式跨电脑生命周期联动未实现。 D2 待实施：成员/项目/端点撤销联动预授权和待投递请求，见[交付切片 1](25-agent-collaboration-delivery.md#slice-1)。 | [归档事务](../../packages/db/src/project-lifecycle.ts) / [回归](../../tests/project-archive.test.ts) / [节点](../../packages/db/src/node-execution.ts) |
| HX-DEV-04-01 | Task 基础、归属和修订 | BE | 部分实现 | 主线已有 Task 修订、真实权限、真人改派/历史和独立参与关系；本人加入退出、编辑者管理、撤权结束和历史回执不复活已接入。参与不授予权限或改动运行材料。本候选纳入 PR40 的工作说明固定基线、冲突对照/明确载入、当前编辑权与同包同键回执确认，以及 PR41 普通创建独立 96 KiB JSON 预算，另补创建旧回执事务内当前空间/项目编辑权复核，既有字符上限不变；这些 PR56 范围已完成自身验收，仍未合并。PR58 创建恢复固定首次正文/幂等键，未知结果确认原包、有效 ACK 后仅 GET，并隔离创建请求的旧身份/空间拒绝通知；精确 CI188 与最终原图已验收，保持未合并。未纳入 Task 内容历史/版本对照，私有转共享及正式存储完整模型仍缺。 | [任务](../../packages/db/src/store.ts) / [编辑说明](../engineering/task-edit-baseline.md) / [整合记录](history/2026-10-02-task-reliability-integration.md) |
| HX-DEV-04-02 | 完成、重开、取消与活动执行联动 | BE/FE | 部分实现 | 主线已有完成/重开/取消及活动执行后端联动。本候选纳入 PR48 已取消 Task 的详情/成果重开入口、PR49 当前权限与固定修订确认、PR50 详情取消及全部活动执行 stop/keep、PR55 完成/取消确认的未知结果原包原键恢复及成功 ACK 后仅 GET 刷新，另补状态旧回执在事务开始后的当前编辑权复核；这些 PR56 范围已验收、未合并。PR57 已将直接 start/reopen/无活动 complete 接入同一恢复路径并完成自身验收，保持冻结未合并；首次点击仍立即 POST，start 只标记 Task 进行中，不启动 Run。停止请求不是终止事实；未纳入完成记录列表等其他堆叠功能，完整动作 UI 与远程执行联动仍待收口。 | [任务](../../packages/db/src/store.ts) / [确认说明](../engineering/task-completion-confirmation.md) / [直接状态恢复](history/2026-10-02-direct-task-status-recovery.md) |
| HX-DEV-04-03 | 列表、看板、排序、筛选与等待原因 | FE/BE | 部分实现 | 项目看板/列表保留负责人、参与者、标题/编号/说明交集，状态/关注内容与URL恢复；主线PR75含独立rank/revision排序、同列拖拽、键盘菜单及原包恢复。本轮补项目可见Task精确标签筛选，与原条件及顺序组合；无效标签链接不扩大结果。完整等待原因筛选仍未交付。 | [项目](../../apps/web/src/projects.tsx) / [标签](../engineering/task-labels.md) / [恢复记录](history/2026-10-08-task-labels-recovery.md) |
| HX-DEV-04-04 | 可选需求说明、修订与局部采用 | FE/BE | 未实现 | 可编辑 Task 说明不等于独立需求模型；Requirement 修订和局部采用未实现。 | —（尚无可用实现） |
| HX-DEV-04-05 | 子任务、依赖、标签与里程碑 | BE/FE | 部分实现 | 项目可见Task可维护独立修订标签，最多16项/每项32字，规范化后精确区分大小写；标签集合、不可变事件、outbox与回执原子提交，当前权限先于旧回执。详情/工作台/项目列表看板展示只读投影，不改Task正文/修订、排序或模型材料。私有任务标签、项目级目录/改名级联、子任务、依赖与里程碑仍未实现。 | [标签存储](../../packages/db/src/task-labels.ts) / [用法](../engineering/task-labels.md) / [恢复记录](history/2026-10-08-task-labels-recovery.md) |
| HX-DEV-04-06 | 项目/个人入口与 Task DTO 统一 | BE/FE | 部分实现 | 真实项目/个人 Task 共用 DTO、创建和权限；负责人改派保留创建/执行身份，参与者作为当前权限下的读取投影，人员筛选与项目深链接一致；PR60 的状态 URL/列表/看板导航已验收，PR61 关注内容筛选已验收；PR63已验收的说明命中片段继续复用相同可见投影；PR64工作台逐批展开已验收，更早的无项目个人任务可沿原链接进入；PR65本人参与关系的工作台入口已验收；PR66显式包括已取消任务的列表路径已验收。PR68全局Task超过30项后的找回已验收，PR69项目/个人范围与命中来源辨认已验收。跨空间/私有选择性转移与完整归属切换未完成。 | [任务](../../packages/db/src/store.ts) / [参与者](../../packages/db/src/task-participants.ts) |
| HX-DEV-05-01 | 线程、消息、提及与附件关联 | BE/FE | 部分实现 | 任务消息和成果回复已持久化；线程、提及及附件关联未完成。 | [消息](../../packages/db/src/store.ts) / [上下文](../../apps/runner/src/runtime.ts) |
| HX-DEV-05-02 | 项目资料、修订与来源 | BE/FE | 部分实现 | 项目文本/链接资料、稳定 ID/指纹、独立修订/作者、删除恢复和 W1 资料页已接入；当前权限在列表/历史/事件/回执前校验。明确执行选材见 05-05/06；附件上传/存储和仓库连接仍缺。 | [事务](../../packages/db/src/project-sources.ts) / [资料页](../../apps/web/src/project-sources.tsx) |
| HX-DEV-05-03 | 从讨论保存团队约定 | BE/FE | 部分实现 | 同项目公开讨论可明确保存为约定，来源/修订、修改、停用/启用、原子替代、权限/回放和 W1 任务内变化提示已有；不自动发送模型。持久提醒、任务子范围和完整送达联动仍缺。 | [约定事务](../../packages/db/src/project-agreements.ts) / [界面](../../apps/web/src/project-agreements.tsx) |
| HX-DEV-05-04 | AI 草稿与局部编辑/采用 | FE/BE | 部分实现 | 已有 AI 回复明确保存独立草稿/修订，选择片段追加或替换同任务说明/同项目资料，双版本检查、采用前后记录和回执同事务；W1 冲突/历史、只读键盘/鼠标选区与 CRLF 原文偏移映射已接入；本机切片完整回归已通过，证据见 21。独立需求/成果目标、自动生成和批量采用仍缺。 | [草稿事务](../../packages/db/src/ai-drafts.ts) / [采用界面](../../apps/web/src/draft-adoption.tsx) |
| HX-DEV-05-05 | 按权限与目的准备上下文 | BE/RN | 部分实现 | 原生/节点开始与接续可明确选取同项目资料/约定、固定版本和摘录，ContextBundle 与 Run/Operation 原子绑定，预算和启动前权限/版本复核已有；原任务/来源材料规则保留。自动推荐、协助/并行目的、附件与跨空间引用仍缺。 D2 待实施：双方有限材料、按轮次补充与输入/输出披露边界，见[交付切片 2](25-agent-collaboration-delivery.md#slice-2)。 | [选材](../../packages/db/src/project-materials.ts) / [节点](../../packages/db/src/node-execution.ts) |
| HX-DEV-05-06 | 上下文面板、送达状态与总结接入 | FE/RN | 部分实现 | W1 明确选材/预算/截断预览、固定历史与启动确认已有；确认绑定选材和人工上下文，未知回执确认原请求。启动不等于 provider receipt；实时输入送达、AI 总结及持久选材偏好仍未交付。 D2 待实施：输入版本和送达/读取/实际消费分开呈现，见[交付切片 2](25-agent-collaboration-delivery.md#slice-2)。 | [选材面板](../../apps/web/src/project-materials.tsx) / [原生](../../apps/runner/src/runtime.ts) |
| HX-DEV-06-01 | Runner CLI、配对与节点身份 | RN/BE | 部分实现 | 独立 CLI、配对、节点身份及本人执行的本机明确授权已有；系统凭证存储、跨电脑传输与完整安装分发未完成。 | [CLI](../../apps/runner/src/cli.ts) / [本机授权](../../apps/runner/src/agent/execution-policy.ts) |
| HX-DEV-06-02 | 主动连接、心跳、spool 与重放 | RN/BE | 部分实现 | 回环主动连接、心跳、摘要和执行证据持久化 ACK/重放已有；重复启动许可拒绝，歧义不重跑。远程 WSS 与完整流量/版本协商未完成。 | [连接](../../apps/runner/src/agent/connection.ts) / [日志](../../apps/runner/src/agent/execution-journal.ts) |
| HX-DEV-06-03 | 目录权限、WorkingCopy 与 Git 状态 | RN | 部分实现 | 本机目录身份、Git 摘要与明确执行子集已有；已接手原目录可逐次同意准备 SHA-1/SHA-256 单提交浅 Git，经独立本人配对登记。完整历史、远程 diff/文件读取、跨平台与通用目录授权仍缺。 | [目录](../../apps/runner/src/agent/workspaces.ts) / [接手Git](../../apps/runner/src/agent/handoff-workspace.ts) |
| HX-DEV-06-04 | 独立工作区、写入约束与资源登记 | RN/BE | 部分实现 | 本机与preview共用持久目录占用；接手/方案复用不覆盖恢复与有限Git准备，旧绑定保持不变。方案独立Node/目录和同组首轮并发已有；未知模型占用保留。跨OS用户、端口/数据库/缓存分配和完整资源治理仍缺。 | [目录锁](../../apps/runner/src/workspace-lease.ts) / [共享Git](../../apps/runner/src/agent/restored-git-workspace.ts) / [方案现场](../../apps/runner/src/agent/branch-workspace.ts) |
| HX-DEV-06-05 | 进程树、输入输出与取消 | RN | 部分实现 | 独立节点实际进程、结构化输出、原生停止与 POSIX 进程组确认已接入；原生输入、Windows 和完整跨平台管理未完成。 | [执行器](../../apps/runner/src/agent/executor.ts) / [进程](../../apps/runner/src/process-host.ts) |
| HX-DEV-06-06 | 重启对账、能力发现与诊断 | RN | 部分实现 | 增加私有原生会话状态与明确清理；保持 pending-executions、未知进程保锁和异常恢复不重跑。系统凭证存储、跨平台与完整自动对账未完成。 | [诊断](../../apps/runner/src/agent/execution-journal.ts) / [CLI](../../apps/runner/src/cli.ts) |
| HX-DEV-07-01 | Run、配置快照和状态 reducer | BE/RN | 部分实现 | 同一 Run 模型支持 node provider 和固定派发/本机策略快照；接单、许可、实际启动各有证据。协助/并行/模板完整模型与原生会话映射仍缺。 | [执行契约](../../packages/contracts/src/node-execution.ts) / [派发](../../packages/db/src/node-execution.ts) |
| HX-DEV-07-02 | 持久化派发、ACK 与幂等 | BE/RN | 部分实现 | 节点派发/幂等/一次性许可、接续预约与Operation原子关联已有；方案首轮Run/分支关联同事务，同组不同现场可并发且每节点仍单执行，自动任务状态修订不吞人工变化。远程WSS、正式存储和通用队列仍缺。 | [派发](../../packages/db/src/node-execution.ts) / [日志](../../apps/runner/src/agent/execution-journal.ts) / [方案绑定](../../packages/db/src/work-branch-workspaces.ts) |
| HX-DEV-07-03 | 归一化事件、游标和权限 SSE | BE/FE | 部分实现 | 节点状态/有界输出/终态通过持久事件回到原任务和权限 SSE；撤权后丢弃内容只收结算证据。完整原生差异、用量、流式增量和远程通道仍缺。 D2 待实施：协作结果与原生继续的来源、关联和确认事实，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [事件](../../packages/db/src/node-execution.ts) / [节点](../../apps/runner/src/agent/executor.ts) |
| HX-DEV-07-04 | 运行输入与下一轮队列 | BE/RN | 部分实现 | 节点下一轮要求、编辑/撤回与实际启动状态已有；等待接续固定选择的版本，变更暂停而非静默采用。原生即时输入、澄清和 provider receipt 未实现。 D2 待实施：所选入口的有界等待/查询或实际支持的回接，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [队列](../../packages/db/src/next-inputs.ts) / [界面](../../apps/web/src/next-inputs.tsx) |
| HX-DEV-07-05 | 绑定式动作授权与真实拒绝 | BE/RN | 部分实现 | 模拟授权与原生额外请求默认拒绝已有；真实动作绑定授权问答尚未实现。 | [状态/事务](../../packages/db/src/store.ts) / [接口](../../apps/control/src/app.ts) |
| HX-DEV-07-06 | 停止、取消、竞争与恢复 | RN/BE | 部分实现 | 本机/节点停止、队列取消、未知保锁已有；E2b4 增加等待取消、超时、重启暂停及停止后复核。完整跨平台/远程对账仍未完成。 D2 待实施：取消后续回接与停止执行分别核对，未知启动不重放，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [派发](../../packages/db/src/node-execution.ts) / [恢复](../../apps/runner/src/agent/execution-commands.ts) |
| HX-DEV-08-01 | Claude 路径、账号方式与能力声明 | RN | 部分实现 | CLI 路径、独立 API 配置与必要参数探测已有；官方 2.1.283 无模型检查通过并修正隐藏 max-turns 误判。其他账号方式、真实账户联调未完成。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-08-02 | Claude 启动与结构化流 | RN | 部分实现 | preview 与独立节点均接受限 Claude CLI 结构化流；真实进程/Git 测试为显式协议替身。真实提供方模型生成仍未联调。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [独立节点](../../apps/runner/src/agent/executor.ts) |
| HX-DEV-08-03 | Claude 原生会话与恢复映射 | RN | 部分实现 | E2c2 节点私有历史、UUID 映射、显式 --resume、绑定/指纹与初始化/终态核对、任务入口和本机清理已实现。真实账户成功恢复及失败历史对账仍未联调。 | [Claude 会话](../../apps/runner/src/agent/claude-sessions.ts) / [执行器](../../apps/runner/src/agent/executor.ts) |
| HX-DEV-08-04 | Claude 输入、澄清与权限桥接 | RN | 未实现 | 原生运行中输入、澄清和完整权限桥接未实现；默认拒绝额外请求不算完成。 | —（尚无可用实现） |
| HX-DEV-08-05 | Claude 中断与失败降级 | RN | 部分实现 | 实际停止、超时、未知保锁已有；恢复缺历史/错 ID/模型/权限失败不自动新建或重试。真实账户恢复诊断及跨平台恢复未完成。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-08-06 | Claude 用量、结果与资源配置 | RN/FE | 部分实现 | 原生结果、用量来源及本机预算配置已有；真实费用核对、完整资源配置与账户能力未验证。 | [Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts) |
| HX-DEV-09-01 | Codex stdio、握手与版本能力 | RN | 部分实现 | 本机 stdio、握手与能力探测已有，既有官方无模型检查有记录；完整版本兼容矩阵未完成。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-02 | Codex thread/turn 与引用 | RN | 部分实现 | E2c1 增加节点私有会话、read/resume/turn 引用与同范围显式恢复；默认仍新会话。有效账户真实历史恢复未联调，完整恢复/失败会话对账尚缺。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-03 | Codex 事件、增量和结果映射 | RN | 部分实现 | preview 与独立节点均接 Codex 事件/结果/异常映射；节点只共享有界文本，完整原生引用/用量及真实提供方生成未联调。 | [Codex](../../packages/adapters/codex/src/index.ts) / [独立节点](../../apps/runner/src/agent/executor.ts) |
| HX-DEV-09-04 | Codex 模型目录、输入与反向请求 | RN | 部分实现 | 模型目录与额外反向请求拒绝已有；实时输入、steer 与完整授权交互未实现。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-05 | Codex 中断、重连与对账 | RN | 部分实现 | 恢复引导取消、错 ID/模型/权限拒绝、历史缺失/换 Key/过期/异常重启阻止恢复已有；运行中 steer、未知原生会话自动对账与跨平台验证未完成。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-09-06 | Codex 用量、配置与限制展示 | RN/FE | 部分实现 | 增加保留授权、恢复期限、继承历史提示、本机列表/清理与创建/恢复标记；真实模型计费、账户互操作及完整用量仍未验证。 | [Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts) |
| HX-DEV-10-01 | 任务页面与双状态头 | FE | 部分实现 | W1 单一任务容器、业务／执行双状态、实际代码来源、可折叠调宽双栏和手机面板切换、上下文／执行历史抽屉及真人负责人改派/历史、创建者与发起者区分已有；复杂多工作线仍未交付。 | [任务](../../apps/web/src/task-workspace.tsx) |
| HX-DEV-10-02 | 协作消息、事件与草稿 | FE | 部分实现 | 已迁移实际消息／原生事件，新增身份空间内存草稿、发送失败保留与历史阅读保护；完整流式增量合并、分页历史加载及刷新草稿恢复仍未实现。 | [讨论](../../apps/web/src/discussion.tsx) / [草稿](../../apps/web/src/state.tsx) |
| HX-DEV-10-03 | 工具/模型/节点与运行控制 | FE/RN | 部分实现 | W1 输入区分讨论和下一轮要求；工具/模型/节点、停止、接续与显式 Claude/Codex 恢复已有。接手卡增加本机Git指引、本人原项目配对和同Task新Run入口；实时 steer、跨电脑与真实模型联调仍缺。 | [输入](../../apps/web/src/prompt-bar.tsx) / [执行](../../apps/web/src/node-execution.tsx) / [接手入口](../../apps/web/src/handoff-workspace.tsx) |
| HX-DEV-10-04 | 文件、diff 与外部 IDE | FE/RN | 部分实现 | W1面板显示本机授权目录的文件列表/diff/分支与采集时间；方案成果增加固定提交引用和节点明确共享的有界两侧文件比较。活动节点远程文件浏览、完整行级diff/编辑器、未提交快照与IDE衔接仍缺。 | [现场代码](../../apps/web/src/native.tsx) / [成果代码](../../apps/web/src/result-code.tsx) |
| HX-DEV-10-05 | 受控交互终端与输入权 | FE/RN | 未实现 | 带输入权的受控交互终端、重连和会话清理未实现。 | —（尚无可用实现） |
| HX-DEV-10-06 | 上下文、协助、成果插槽整合 | FE | 部分实现 | W1 已整合工作说明、过程、成果、配置／队列和接续异常；明确选材快照、真人/Claude 文本协助与建议采用已有。自动上下文整理、更多协助材料和其他目标仍缺。 D2 待实施：原 Task 内关联请求、双方、成果与继续，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [工作区](../../apps/web/src/task-workspace.tsx) |
| HX-DEV-11-01 | 继续命令与针对性预检 | BE/RN | 部分实现 | preview 与 node 均有 202 持久化 Operation、显式 wait/request_stop、查询/取消和幂等；节点固定本次材料与授权。完整 ContextBundle、跨节点与扩展协助材料权限仍缺；已有单消息有限授权见 11-03。 D2 待实施：协作返回结果后的当前权限/材料核对与继续关联，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [节点接续](../../packages/db/src/node-execution.ts) / [契约](../../packages/contracts/src/next-input.ts) |
| HX-DEV-11-02 | 同机接续、停止后继续与重开 | RN/BE | 部分实现 | E2b4 自动等待仍新会话；E2c1/E2c2 Codex 与 Claude 可在成功终态后显式恢复私有原生会话，保留来源与原目录。自动等待原生恢复、跨成员/机器接手与真实模型联调仍缺。 | [节点执行](../../packages/db/src/node-execution.ts) / [进程](../../apps/runner/src/agent/executor.ts) |
| HX-DEV-11-03 | Assistance、所选快照与有限访问 | BE | 部分实现 | 已接入同空间真人 Assistance、单条消息固定摘录、明确分享与 snapshot_reply 有限授权；接收者不获得 Task/Project 权限，撤权同事务永久失效。文件/diff/成果材料、跨空间与远程共享仍缺。 D2 待实施：独立 Agent 发起/接收、固定材料与有限双向协商，见[交付切片 2](25-agent-collaboration-delivery.md#slice-2)。 | [协助事务](../../packages/db/src/assistance.ts) / [契约](../../packages/contracts/src/assistance.ts) |
| HX-DEV-11-04 | 真人回应与 AI 协助 Run | BE/RN | 部分实现 | 真人回复/追问、修订冲突、结束/撤销和原任务关联已接入，不修改负责人/运行或模型材料。另接入本人明确授权的 Claude 纯文本 assist Run、独立临时环境及最终建议回写；文件/代码协助、Codex 文本边界与真实模型联调未交付。 D2 待实施：原生入口、真实接收适配、接受/拒绝/澄清和来源，不伪造受管 Run，见[交付切片 3](25-agent-collaboration-delivery.md#slice-3)。 | [协助](../../packages/db/src/assistance.ts) / [界面](../../apps/web/src/assistance.tsx) |
| HX-DEV-11-05 | 继续/协助抽屉与就地回复 | FE | 部分实现 | 保留原接续面板；新增 W1 消息选材与真人邀请抽屉、收发件、有限独立详情、原任务回复记录、原回执确认及权限清理。增加 AI 固定文本、节点与材料/费用确认、原请求确认和独立执行状态；文件材料、AI 追问与远程入口仍缺。 D2 待实施：能力选择、协商、原生入口与任务内状态，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [邀请](../../apps/web/src/assistance-create.tsx) / [协助](../../apps/web/src/assistance.tsx) |
| HX-DEV-11-06 | 采纳、追问、取消与恢复 | FE/BE | 部分实现 | 真人协助追问、明确结束/撤销、过期来源提示和网络/并发保留已接入，旧回执不重复回复或复活授权。AI 取消/实际停止及未知本机确认已接入，不影响主运行或目录锁。真人/有效 AI 建议可多片段明确采用到原任务说明，来源/目标修订和权限重查、等待接续暂停、不可变记录及幂等同事务；更多目标、AI 会话恢复与重新分享仍缺。 D2 待实施：Agent 消费结果继续与人工采用分开；取消/未知结果恢复，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [采用事务](../../packages/db/src/assistance-adoption.ts) / [回归](../../tests/assistance-adoption.test.ts) |
| HX-DEV-12-01 | 多仓库提交/补丁检查点 | RN | 部分实现 | 单仓库 team-local 项目任务的本人本机提交引用已接入：完整 commit/root-tree 哈希核对、独立逐次同意、不可变记录与排除项、当前权限和原子回执。仅本机引用，不是备份；多仓库、补丁/文件清单、remote identity 与恢复仍缺；单提交文件对象保留见12-02。 | [核对](../../apps/runner/src/agent/checkpoints.ts) / [事务](../../packages/db/src/checkpoints.ts) / [用法](../engineering/commit-checkpoints.md) |
| HX-DEV-12-02 | 检查点传输与目标恢复 | RN/BE | 部分实现 | 原本人/接收者各自 Linux 新目录恢复、清理、报告与同项目加密传输已有；成功接手后可明确新增有限Git并独立授权研发，不修改原代码/旧凭证。仍限同服务回环；跨电脑、多仓库/补丁/LFS与完整历史仍缺。 | [传输](../../packages/db/src/checkpoint-transfer.ts) / [接收恢复](../../apps/runner/src/agent/checkpoint-received-source.ts) / [接手现场](../engineering/handoff-workspace.md) |
| HX-DEV-12-03 | Handoff 发布、接受与状态 | BE | 部分实现 | 邀请发布/关闭/到期、独立接受操作与任务预约、原节点本机新核验、操作者与回执原子提交已有；服务重启/上下文变化暂停。自动现场恢复编排及完整跨电脑接手仍缺。 | [邀请](../../packages/db/src/handoffs.ts) / [接受事务](../../packages/db/src/handoff-acceptance.ts) / [本机核验](../../apps/runner/src/agent/handoff-acceptance.ts) |
| HX-DEV-12-04 | 选择性分享和跨空间明确发布 | BE/FE | 未实现 | 选择性分享与跨空间明确发布未实现。 | —（尚无可用实现） |
| HX-DEV-12-05 | 接手卡与责任可选转移 | FE | 部分实现 | W1 接手材料/说明、接受进度、操作者与可选负责人移交已有；新增原目录Git准备指引、本人配对与原执行面板。Git准备历史留在本机，不伪造服务回执；自动编排及远程完整体验仍缺。 | [邀请](../../apps/web/src/handoffs.tsx) / [研发入口](../../apps/web/src/handoff-workspace.tsx) / [用法](../engineering/handoff-workspace.md) |
| HX-DEV-12-06 | 接手刷新恢复与部分失败处理 | RN/BE | 部分实现 | 邀请/接受刷新、固定回执、权限/上下文及重启暂停已有；Git准备增加持久尝试、失败元数据归属清理与清理后明确重试。未知写入保留，网页降权清除临时码并保留进度。自动恢复编排与跨电脑失败处置仍缺。 | [接受回归](../../tests/handoff-acceptance.test.ts) / [Git准备回归](../../tests/handoff-workspace.test.ts) / [浏览器](../../tests/e2e/checkpoint-retention.spec.ts) |
| HX-DEV-13-01 | WorkBranch 与共同起点 | BE | 部分实现 | 同任务2—6方案组、固定说明/提交、独立目标/修订/历史与W1抽屉已有；登记关联WorkingCopy，首轮Run同事务关联，实际启动记录active。明确保存文字成果才ready，selected由固定版本选择投影。更多共同材料与完整代码生命周期仍缺。 | [事务](../../packages/db/src/work-branches.ts) / [界面](../../apps/web/src/work-branches.tsx) / [用法](../engineering/work-branches.md) |
| HX-DEV-13-02 | 分支独立现场与并发执行 | RN/BE | 部分实现 | 同机Linux原本人副本独立恢复/Git、新节点登记、首轮真实文件/树复核及同组不同现场的Claude/Codex协议进程并发已接入；单独授权/停止，原目录/凭证保持。组级预算/资源队列、跨成员/远程准备和完整拓扑仍缺。 | [事务](../../packages/db/src/work-branch-workspaces.ts) / [本机](../../apps/runner/src/agent/branch-workspace.ts) / [用法](../engineering/branch-workspaces.md) |
| HX-DEV-13-03 | 分支成果绑定与部分失败 | BE | 部分实现 | 终态Run/真实方案关联、固定输入/共享输出、说明/限制及不可变版本已有；可选本人同目录的结束后提交引用/有效对象副本，节点另行核验并明确共享有界文件对比。失败/取消保留原状态，旧版/反馈/选择不漂移。未提交快照、完整文件/预览与日志仍缺。 | [固定成果](../../packages/db/src/work-branch-results.ts) / [代码关联](../../packages/db/src/result-code.ts) |
| HX-DEV-13-04 | 方案对比与选择继续 | FE/BE | 部分实现 | 同组版本/来源/只读代码比较、固定选择/替换/取消与历史已有；本人可另行确认所选代码在原目录的新会话Run，固定选择/来源/材料并在许可前后核验实际文件，旧结果/反馈不变。当前要求干净匹配提交；方案等待/原生恢复、脏现场、完整diff/预览及AI差异建议仍缺。 | [比较事务](../../packages/db/src/branch-comparison.ts) / [接续](../../packages/db/src/branch-continuation.ts) / [用法](../engineering/branch-continuation.md) |
| HX-DEV-13-05 | 固定版本的选择性整合 | RN/BE | 部分实现 | 已固定一个源成果版本、本人目标提交/恢复副本，复用完整保留/接收对象与共同起点，记录文件级三方预检、冲突/省略、不可变报告和取消历史；目标现场/权限/回执重新核验。尚无实际应用、文件/提交选择、冲突解决、多来源编排或部分写入恢复。 | [整合事务](../../packages/db/src/integrations.ts) / [预检](../../apps/runner/src/agent/integration-preflight.ts) / [用法](../engineering/integration-preflight.md) |
| HX-DEV-13-06 | 分支停止、丢弃与清理保护 | RN/FE | 部分实现 | 未持有现场的planned可放弃；准备可取消/处置失败材料，已发布代码保留。首轮及选定成果后的Run可独立停止；准备失败可重新预览并明确发起，未知进程不解锁，不重放付费执行。已登记目录清理、待发包处置、脏现场与完整恢复仍缺。 | [本机](../../apps/runner/src/agent/branch-workspace.ts) / [接续回归](../../tests/branch-continuation-runner.test.ts) |
| HX-DEV-14-01 | Result/Revision 与基础产物 | BE | 部分实现 | Result/不可变Revision及旧版兼容已有；方案可关联固定提交/副本，追加每版本一份的不可变代码对比报告，文本blob哈希和发布预算受控。文件下载/托管、未提交捕获、完整diff、真实预览与多附件模型仍缺。 D2 待实施：外部结果版本、请求/输入/身份来源与实际消费关联，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [版本仓储](../../packages/db/src/result-revisions.ts) / [代码契约](../../packages/contracts/src/result-code.ts) |
| HX-DEV-14-02 | 成果卡、版本与说明编辑 | FE | 部分实现 | W1成果入口、版本切换/深链接、历史正文/来源与方案追加版本已有；详情新增当前所看版本的显式固定链接，单版本亦可直接打开/复制；PR67成果库项目/关键词交集、来源与说明命中片段已验收，沿原详情打开；代码引用选择、副本当前状态、节点共享的两侧文件正文和省略项可查看。故障保留、撤权清除、未知回执对账；非方案编辑、完整文件/diff/真实预览仍缺。 D2 待实施：协作产物、来源和继续位置展示，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [成果](../../apps/web/src/results.tsx) / [代码对比](../../apps/web/src/result-code.tsx) |
| HX-DEV-14-03 | 预览会话与主动隧道 | RN/BE | 未实现 | 通用预览会话与主动隧道未实现；订单示例页不是用户项目预览。 | —（尚无可用实现） |
| HX-DEV-14-04 | 预览独立身份与失效回退 | BE/FE | 未实现 | 独立预览身份、授权失效与真实预览回退未实现。 | —（尚无可用实现） |
| HX-DEV-14-05 | 版本反馈、回复与后续任务 | FE/BE | 部分实现 | 新成果反馈绑定明确ResultRevision，切换/刷新不漂移，旧未指定版本反馈单列；仍保存在原Task，完成无需报告。文件区域锚点、独立回复关系与建立后续任务仍缺。 D2 待实施：结果反馈/澄清回到原请求并供原 Agent 继续，见[交付切片 4](25-agent-collaboration-delivery.md#slice-4)。 | [反馈](../../apps/web/src/results.tsx) / [讨论](../../apps/web/src/discussion.tsx) |
| HX-DEV-14-06 | 可选报告、发布引用与完成整合 | FE/BE | 已完成 | PR73手动固定ResultRevision报告/发布HTTP(S)引用、环境/来源/真实记录人及未知外部状态、20有效链接增删与原请求恢复，已与原项目成果列表、无需报告完成/明确重开按原三条件合验；CI212729工程/288Chromium全通过，最终8张原图及正文回读完成。引用不自动抓取或证明报告通过/上线，自动连接器和预览仍属各自后续范围。 | [手动链接](../../apps/web/src/result-references.tsx) / [项目成果](../../apps/web/src/projects.tsx) / [记录](history/2026-10-05-result-reference-links.md) |
| HX-DEV-15-01 | 我的工作和项目概览查询 | BE | 部分实现 | 工作台和项目聚合按真实主体/空间/项目权限过滤；完整团队汇总与协助/接手查询仍缺。 D2 待实施：按当前权限聚合本条协作状态，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [工作台](../../packages/db/src/store.ts) |
| HX-DEV-15-02 | 工作台、待回复与成果视图 | FE | 部分实现 | W1 工作台从当前可见 Task/Run/Result 聚合个人／团队工作、关注事项和最近成果，已完成任务的活动执行仍展示；真人/AI 协助收发件入口已有；PR64最近任务逐批展开/收起和当前列表计数已验收；PR65「我参与的」页签及相应继续/关注/成果集合已验收；PR66最近列表显式包括已取消任务已验收，原其他聚合不变。完整持久通知、统一待处理聚合与接手提醒仍缺。 D2 待实施：需人处理、已有成果与待继续的真实投影，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | [工作台](../../apps/web/src/workbench.tsx) |
| HX-DEV-15-03 | 通知投影、去重与偏好 | BE/FE | 未实现 | 通知投影、去重和个人偏好未实现。 D2 待实施：先交付协作链待处理、持久通知与去重子集，见[交付切片 6](25-agent-collaboration-delivery.md#slice-6)。 | —（尚无可用实现） |
| HX-DEV-15-04 | 有权限的中文关键词搜索 | BE/FE | 部分实现 | 已满足：Task关键词/说明片段、PR67当前成果库项目查找、PR68 Task稳定分页和PR69项目/个人范围及来源/当前修订。PR70全局入口显式Task/Result类型、当前Result关联Task后的范围/关键词分页、来源/版本/正文命中及原详情导航亦已验收。PR72约定类型、当前标题/正文与全部生命周期状态的真实修订、项目来源和稳定分页已验收。尚欠：需求/消息等资源及其类型/项目过滤、来源/修订、失效与分页；历史全文未提供，语义检索仍属可选后续方向。 | [全局搜索](../../apps/web/src/command-menu.tsx)、[成果查询](../../packages/contracts/src/result-search.ts) |
| HX-DEV-15-05 | 用量去重、费用来源与预算提示 | BE | 部分实现 | 原生用量事件和费用来源说明已有；计量账本、统一去重聚合和预算提示未完成。 | [查询](../../apps/control/src/app.ts) / [工作台](../../apps/web/src/App.tsx) |
| HX-DEV-15-06 | 费用、成员工作与陈旧状态 UI | FE | 部分实现 | 已实现成员目录→当前已加载可见的负责/明确参与Task→原详情，原顺序、关系/来源、全Task状态与8项逐批；PR71精确CI208707工程/271Chromium及242/243、228–231实图和正文回读已完成，真实team-local只读成员子路径已验收。费用面板、统一陈旧状态及完整管理视图仍缺，示例身份和局部Run状态不代替这些能力。 | [成员工作](../../apps/web/src/member-work.tsx) / [投影](../../apps/web/src/member-work-projection.ts) / [记录](history/2026-10-05-member-work-view.md) |
| HX-DEV-16-01 | 模板、版本与步骤编辑 | BE/FE | 未实现 | 协作模板、版本和步骤编辑未实现。 | —（尚无可用实现） |
| HX-DEV-16-02 | 实例调度与普通 Run 复用 | BE/RN | 未实现 | 模板实例调度和普通 Run 复用未实现。 | —（尚无可用实现） |
| HX-DEV-16-03 | 实例继续、跳过与取消联动 | BE/FE | 未实现 | 模板实例继续、跳过与取消未实现。 | —（尚无可用实现） |
| HX-DEV-16-04 | 连接器、外部引用与首个 Git/PR 接入 | BE | 未实现 | 外部连接器、引用及 Git/PR 产品集成未实现；开发仓库托管在 GitHub 不算产品集成。 D2 待实施：参与身份与端点分离、能力三维状态及原生 API/MCP 薄入口；原 Git/PR 目标保留，见[交付切片 1](25-agent-collaboration-delivery.md#slice-1)。 | —（尚无可用实现） |
| HX-DEV-16-05 | Webhook、去重与可选自动完成 | BE | 未实现 | 外部 Webhook、去重与可选自动完成未实现。 D2 待实施：请求可靠投递、来源验证、回执/乱序与原标识查询；业务协商归 11，见[交付切片 2](25-agent-collaboration-delivery.md#slice-2)。 | —（尚无可用实现） |
| HX-DEV-16-06 | 可选 CI/发布/通知与连接状态 | BE/FE | 未实现 | 可选 CI/发布/通知产品集成未实现；开发 CI 不算产品业务功能。 D2 待实施：能力登记/撤销、共享条件、原生入口和连接状态，见[交付切片 1](25-agent-collaboration-delivery.md#slice-1)。 | —（尚无可用实现） |
| HX-DEV-17-01 | 自托管安装、HTTPS 与初始化 | OPS/BE | 未实现 | 面向团队的自托管安装、HTTPS 和初始化未实现；本机启动不是公网部署。 D2 待实施：首个里程碑所需最小独立远程部署，当前回环模式不直接公开，见[交付切片 5](25-agent-collaboration-delivery.md#slice-5)。 | —（尚无可用实现） |
| HX-DEV-17-02 | 团队远程节点与受控环境 | RN/OPS | 未实现 | 团队远程节点和受控运行环境未实现。 | —（尚无可用实现） |
| HX-DEV-17-03 | 预览、端口、临时资源与清理 | RN/OPS | 未实现 | 远程预览、端口与临时资源治理未实现。 | —（尚无可用实现） |
| HX-DEV-17-04 | Runner 分发、升级与回退 | RN/OPS | 未实现 | Runner 分发、升级与回退未实现。 | —（尚无可用实现） |
| HX-DEV-17-05 | 备份恢复、迁移和状态对账 | BE/OPS | 未实现 | 正式备份恢复、生产迁移和多节点对账未实现；本地 SQLite 迁移归属 01。 D2 待实施：有限协作的持久状态、备份/恢复和外部请求核对，见[交付切片 5](25-agent-collaboration-delivery.md#slice-5)。 | —（尚无可用实现） |
| HX-DEV-17-06 | 维护诊断、脱敏导出与保留策略 | FE/BE/OPS | 未实现 | 运维诊断、脱敏导出与保留策略未实现。 D2 待实施：首条远端协作配置、诊断与真实联调记录，见[交付切片 5](25-agent-collaboration-delivery.md#slice-5)。 | —（尚无可用实现） |

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

详细依赖以 00 和各计划为准，不按编号机械串行。E0—E1c 的本机工具预览保留；E2a 新增独立的真实账号与协作数据模式。E2b2—E2b4 增加本人节点执行、下一轮要求和持久化同目录接续；Claude/Codex 有界会话代码路径亦已接入；后续按 22 推进，不能让团队账号继承宿主机权限。
