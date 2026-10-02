# 21｜当前实现进度

更新：2026-10-02。当前候选从 main `a3ae2e8` 独立提取 Task 可靠性修正：PR40/41/48/49/50/55，仅附带 PR33 的普通事务 `beforeReplay` 回调，另修补创建/状态旧回执在事务开始后的当前权限检查缺口。候选尚未完成自身验证，未合并或部署；旧堆叠分支的通过记录不等于本候选已通过。原工作项见 [19](19-work-items.md)，唯一下一项见 [22](22-next-delivery.md)，范围与取证见[整合记录](history/2026-10-02-task-reliability-integration.md)。

## main 基线能力

| 范围 | 已接入的实际范围 | 仍需区分的限制 |
| --- | --- | --- |
| Workbench W1 | 现有页面完成重建，旧呈现层删除；深浅色、密度、窄屏、动效与输入/抽屉保护 | 桌面宿主/安装包未交付；演示不供给真实状态 |
| 项目与任务 | 创建、说明、状态、成果讨论、项目设置/归档、负责人/参与关系及人员筛选 | 独立需求、子任务/依赖/里程碑、完整筛选排序仍缺 |
| 真实账号 | team-local 账号、个人/团队空间、手动邀请、项目角色和撤权 | 仅同机回环；邮件验证、找回密码、正式服务未交付 |
| 资料与内容 | 文本/链接、修订、约定、明确选材与 Run/Operation 快照、草稿/协助建议局部采用 | 不抓取链接；附件、自动总结/推荐、更多采用目标仍缺 |
| 原生 coding | preview 与本人独立节点的受限 Claude/Codex 进程、结构化事件、停止与工作区锁 | 实验性代码路径；真实账户模型生成尚未联调 |
| 接续与恢复 | 同任务/原目录的新 Run；等待/停止后接续、下一轮要求；Claude/Codex 本机 opt-in 私有会话恢复 | 运行中即时输入/steer、跨电脑接续仍缺；真实模型恢复未联调 |
| 协助 | 同空间真人固定消息摘录/有限回复；另行授权的 Claude 无工具文本协助；建议采用 | AI 协助的 Codex 等价路径、代码/文件材料、跨空间/跨电脑分享仍缺 |
| Git 检查点 | 提交引用、对象保留/核验/期限/删除、Linux 新目录恢复/清理及任务内报告；同项目双节点加密传输、接收者独立恢复与报告 | 仍限同控制服务、同机回环；最后报告不是实时文件检测；不含祖先/LFS/子模块实体和未提交内容 |
| 接手 | 邀请/独立接受、原节点新核验、当前操作者与可选负责人；接手原目录明确准备有限 Git、生成本人独立配对配置、单独授权后在同 Task 新 Run | 同机 Linux；单提交浅历史，准备记录在本机；接受/准备/配对不自动授权模型，自动编排、完整材料/历史与跨电脑仍缺 |
| 方案分支 | 同Task固定方案组；本人独立恢复/Git、节点登记/单独授权、首轮起点核验与同组独立并发；所选固定版本后、原本人同目录的新会话Run，保留来源/选择/旧成果与独立停止 | 同机Linux；接续需实际目录干净匹配所选提交；方案自动等待/原生恢复、脏现场/跨目录继续、代码实际应用、已登记目录清理、组级资源/预算仍缺；真实模型未联调 |
| 成果与选择 | 不可变文字版本、来源/共享输出、版本反馈与旧数据兼容；可选固定提交/副本状态，节点明确共享有界代码对比；固定版本比较/选择/取消，后续成果记录接续来源 | 引用不是备份，显示包不是完整补丁；未提交捕获、完整文件/diff/真实预览、AI差异建议、非方案后续版本编辑与实际整合写入仍缺 |
| 整合预检 | 固定一个源ResultRevision、本人目标提交/恢复副本，读取完整保留或接收对象与原共同起点；只读三方文件/冲突检查、目标现场核验、明确共享和取消/回执/历史 | 同机Linux普通Git目录，需干净目标；报告最多80文件/48 KiB，省略明确阻止完整应用。没有实际写入、文本自动合并、多来源或冲突解决；旧报告不是当前现场证明 |

## 本次 Task 可靠性候选

| 范围 | 本候选纳入的代码行为 | 验证与剩余边界 |
| --- | --- | --- |
| 工作说明编辑 | 固定 Task/修订/原文，外部变化只做冲突对照；明确载入新基线，同包同键确认未知 PATCH；事务内旧回执前复核当前编辑权 | 来源 [PR40](https://github.com/ntygod/HEXU/pull/40)；不含内容历史、独立 Requirement 或执行输入，见[用法](../engineering/task-edit-baseline.md) |
| 普通 Task 创建 | 本路由独立 96 KiB JSON 字节预算，容纳既有合法中文与全转义输入；标题/说明字符上限、原回执与原子事务保持，另补旧回执事务内当前空间/项目编辑权复核 | 来源 [PR41](https://github.com/ntygod/HEXU/pull/41)；全局及无关路由仍为原预算，无新 schema/迁移 |
| 重开与确认 | 已取消 Task 可从详情和固定成果重开；完成/取消确认跟随当前访问/编辑权和固定修订；详情取消读取同 Task 全部活动 Run 并明确 stop/keep | 来源 [PR48](https://github.com/ntygod/HEXU/pull/48)、[PR49](https://github.com/ntygod/HEXU/pull/49)、[PR50](https://github.com/ntygod/HEXU/pull/50)；Task 状态和真实执行终止分别判断 |
| 未知结果恢复 | 首次发送固定动作/正文/幂等键，关闭后同 Task 状态入口先恢复原包；有效成功 ACK 后读取失败只 GET 刷新 | 来源 [PR55](https://github.com/ntygod/HEXU/pull/55)；另补 complete/cancel/reopen 旧回执事务内当前编辑权复核；Provider 内存按身份/空间隔离，当前撤权清除，不跨硬刷新，见[用法](../engineering/task-completion-confirmation.md) |

上表描述候选代码范围，不声明已完成候选验收。除上述 Task 修正和 [PR33](https://github.com/ntygod/HEXU/pull/33) 普通事务回调这个最小依赖外，不导入其他旧堆叠功能；没有新增数据库 schema/迁移。本轮不检查或修改暂停的原生、文件、私有材料和 registry 范围，[问题52](https://github.com/ntygod/HEXU/issues/52) 保持暂停，也不作整包安全结论。

## 模式与验证边界

- 默认 `preview` 是虚构单用户示例；mock 不启动命令或调用模型。显式配置的原生路径仍属实验接入。
- `team-local` 使用独立业务/认证数据库与真实权限，控制宿主不执行原生/mock 任务；只有本人明确授权的节点可接收执行。两种模式均只支持回环地址。
- 原生/节点完整工程回归以 Linux 为准；macOS 未实测，Windows 原生执行不支持。Web 页面通过不代表进程/凭证边界跨平台完成。
- 协议替身测试、官方程序无模型兼容检查、有效账户真实互操作是三类证据；前两类不能证明真实模型生成/费用/历史恢复。已核验工具版本和过程看历史及 [Claude](../engineering/claude-sessions.md) / [Codex](../engineering/codex-sessions.md) 说明。
- 完整跨成员代码接手、完整方案代码产物/扩展接续/整合、通用项目预览、外部 Git/PR 集成、模板/自动化、正式远程部署与安装升级仍待交付。项目仓库使用 GitHub/CI，不等于产品已经实现这些集成。

## 最近验证与交付位置

| 对象 | 实际证据与适用范围 |
| --- | --- |
| main `a3ae2e8` 基线 | [CI121 / 36658556183](https://github.com/ntygod/HEXU/actions/runs/36658556183)：596/596 工程通过、Chromium 123/124；固定成果版本 URL 用例 1 项失败。实际 trace 显示测试在 v2 加载时读到空选项，之后以未定义目标选择 v2；本候选只修该用例的加载/固定 ID 前置条件，尚待重验，不更改该基线问题的成果生产逻辑 |
| 旧堆叠最终 [PR55](https://github.com/ntygod/HEXU/pull/55) `e977fb24` | [CI182 / 37042961842](https://github.com/ntygod/HEXU/actions/runs/37042961842)：1169/1169 工程、349/349 Chromium 与汇总通过；199/200 原图实际查看。只证明该完整堆叠 head，不覆盖本 main 候选 |
| 本 main Task 候选 | 新鲜构建后相关工程 **38/38** 通过（含 22 项新增），类型/UI token/格式/构建及严格 E2E 类型通过；事务回调禁用反证 0/2、恢复后 2/2。首次本地全量检查通过类型/UI token/服务端构建后，在原 AI 进程夹具的 workspace-leases 目录创建处遇到 ENOENT 并在清理等待后中断，不能记为工程全通过；浏览器/视觉验收尚未完成。已发现 172 条浏览器用例（124 条基线 + 48 条适配新增），发现数不等于执行通过；无可据以宣称通过的候选 CI。最终结果按实际运行写回本页及[历史](history/2026-10-02-task-reliability-integration.md) |

旧的 25 个草稿 PR（#29—#51、#54、#55）保持冻结、未合并；本次提取不是批准或合入整个堆叠。正式个人客户端、远程团队服务与有效账户 provider 互操作仍缺，历史通过记录不改变这些边界。

### 已入 main 的历史证据

| 范围 | 实际证据 |
| --- | --- |
| PR #20：双节点对象传输，`29a112f` | [Linux CI 36451599766](https://github.com/ntygod/HEXU/actions/runs/36451599766)：450/450 工程测试、101/101 Chromium；格式、类型、UI token 与构建通过 |
| PR #21：接收者独立恢复，`a1edcf2` | [Linux CI 36461020640](https://github.com/ntygod/HEXU/actions/runs/36461020640)：474/474 工程测试、104/104 Chromium；格式、类型、UI token 与构建通过 |
| PR #22：接手邀请，`5483017` | [Linux CI 36510807071](https://github.com/ntygod/HEXU/actions/runs/36510807071)：**482/482 工程测试、106/106 Chromium 流程**，零失败/取消/跳过；格式、类型、UI token 与构建通过。本机先前新增 8/8 工程、2/2 浏览器定向检查亦通过 |
| PR #23：接受接手，`acff453` | [Linux CI 36523058725](https://github.com/ntygod/HEXU/actions/runs/36523058725)：**500/500 工程测试、108/108 Chromium 流程**，格式、类型、UI token 与构建通过；工程/浏览器独立作业和汇总 check 全部成功。失败与修正见 [接受记录](history/2026-09-29-handoff-acceptance.md) |
| PR #24：接手现场研发，`83a4d5a` | [Linux CI 36527456468](https://github.com/ntygod/HEXU/actions/runs/36527456468)：**511/511工程测试、110/110Chromium流程**，工程/浏览器/汇总check全部通过；类型、UI token、格式与构建通过。此前80/80工程、7/7浏览器定向验证亦通过，详见[现场研发记录](history/2026-09-29-handoff-workspace.md) |
| PR #25：方案定义，`adf5c79` | [Linux CI 36529715672](https://github.com/ntygod/HEXU/actions/runs/36529715672)：**519/519工程、112/112Chromium流程**，类型、UI token、格式和构建通过；此前17工程/2浏览器定向通过。详见[方案定义记录](history/2026-09-29-work-branch-plans.md) |
| PR #26：方案独立现场，`a0fe988` | [Linux CI 36548541717](https://github.com/ntygod/HEXU/actions/runs/36548541717)：**533/533工程、114/114Chromium流程**，工程/浏览器/汇总check均成功；已合入main `c37b730`，失败修正见[现场记录](history/2026-09-29-branch-workspaces.md) |
| PR #27：成果来源预览，`0f4c70d` | [Linux CI 36555794206](https://github.com/ntygod/HEXU/actions/runs/36555794206)的engineering/browser/check均成功；业务代码此前由[CI 36554077449](https://github.com/ntygod/HEXU/actions/runs/36554077449)验证545/545工程、114/114Chromium。已合入main `87d795e`，原范围和修正见[来源记录](history/2026-09-29-branch-result-sources.md) |
| 本地成果版本与比较选择 | Windows Node24.19.0：**75/75相关工程用例**（含14项新增），7条相关Chromium流程均已有通过记录；类型、UI token、格式与构建通过，深色桌面/浅色390px截图实际查看。仅控制层协议夹具，无真实模型或Linux原生执行复测；尚未触发新CI。过程见[本地记录](history/2026-09-29-branch-results.md) |
| 本地固定代码引用与对比 | Node24.19.0：Windows相关38项与Linux相关29项均已有通过记录，交集19项，合计48项不同用例；Linux最后7/7新增代码用例复测通过。8条相关Chromium流程均已有通过记录；类型、UI token、格式和构建通过。真实Git/HTTP及明确协议事件，不调用模型；失败修正、范围见[代码记录](history/2026-09-29-result-code.md) |
| 本地选定方案接续 | Linux97项相关用例均已有通过记录，最后4/4新真实Git/进程用例复测通过；Windows相关25/25，交集6项，共116项不同工程用例。5/5相关Chromium流程、类型/UI token/格式/构建通过；有Claude与切换到Codex的实际协议进程，没有真实模型调用。范围与夹具修正见[接续记录](history/2026-09-30-branch-continuation.md) |
| 本地整合预检 | Windows12/12控制/纯规则；Linux初轮32/32、最后6/6新流程复测，合计45个不同工程用例有通过记录。两条新增Chromium流程、类型/UI token/格式/构建检查；真实Git/完整副本/HTTP，没有目标写入或模型调用。范围、失败断言修正与最后验证见[预检记录](history/2026-09-30-integration-preflight.md) |
| PR #28：完整成果链与两分支整合，`4c27c59` | [Linux CI 36656972962](https://github.com/ntygod/HEXU/actions/runs/36656972962)：**596/596工程测试、124/124Chromium流程**，engineering/browser/check全部success；格式、类型、UI token与构建通过。之后只更新接手/进度文档，业务与测试树不变；实际模型互操作仍未验证，整合过程见[主线记录](history/2026-09-30-result-branch-merge.md) |

PR #20—#28统一进入main，两支历史及全部源码、测试、用法和CI证据保留。来源预览仍只读，固定成果保存独立记录不可变版本；二者均遵守持久结算边界和`shared:false`过滤。统一过程与交付检查见[分支整合记录](history/2026-09-30-result-branch-merge.md)，原提交检查见[预检记录](history/2026-09-30-integration-preflight.md#提交交付)，早期合并见[邀请记录](history/2026-09-29-handoff-offers.md)。

旧证据保留在 [UI 与初始实现](history/2026-09-28-implementation.md)、[恢复预检](history/2026-09-28-restore-preflight.md)、[实际恢复](history/2026-09-28-restore-write.md)、[恢复结果](history/2026-09-28-restore-results.md)。分别包括 336/95、366/95、402/95、425/98 的历史基线，不再把历次长日志复制到本页。

## 进度口径与更新

原 102 行按本候选实际状态统计为 **2 完成 / 78 部分实现 / 22 未实现**。本次增强已有 04-01/04-02 的部分实现，不新增完成项；旧堆叠 2/80/20 不能移用于 main 候选。13-04已有比较/选择及干净固定提交的新会话接续；13-05已有固定源/目标与完整对象只读预检，实际应用和冲突解决仍缺。方案等待/原生恢复、脏现场、AI差异建议及完整代码产物仍待补齐。其他原项仍有完整历史、自动编排、跨平台/跨电脑等剩余范围。工作项大小不同，不能折算产品完成百分比。

能力及验证更新本页和 19；下一项只改 22；用法放工程指南，开发约束放相应 harness。不会根据节点连通、协议替身或历史报告声称跨电脑产品或真实模型联调完成。
