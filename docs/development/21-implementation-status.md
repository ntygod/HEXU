# 21｜当前实现进度

更新：2026-10-08。主线已通过[PR75](https://github.com/ntygod/HEXU/pull/75)整合PR56—74及兄弟PR59，基线为 `ee2434d`；组合[CI37494323995](https://github.com/ntygod/HEXU/actions/runs/37494323995)为746/746工程、312/312Chromium和汇总成功。旧链已归档，原功能范围不由绿灯推断。问题52已通过[PR76](https://github.com/ntygod/HEXU/pull/76)在独立归档修复，修后标签为 `archive/2026-10-07/pr-55-issue52-fixed`，本主线没有原目录应用/恢复代码。

本轮按用户发布请求，从归档PR46选择性恢复项目Task标签，适配当前迁移34、现有筛选和持久排序；传递依赖source-map-js更新为1.2.2，依赖安装审计0告警。类型/源码构建、50项定向工程检查、6项Chromium标签流程和三幅实际截图检查已通过；完整组合CI与最终合并/清理由本轮PR记录，旧链或远端未推送工作的记录不计作本次验收。标签为Task人工协作投影，不改变模型材料或执行权限。见[恢复记录](history/2026-10-08-task-labels-recovery.md)与[用法](../engineering/task-labels.md)。

当前本地候选修正标签输入框的组合输入 Enter：选词阶段不触发加入草稿，普通 Enter 保留原操作。生产事件函数定向 5/5，通过旧处理器 2/5 对照；定向严格类型、React 事件兼容、组件独立转译和修改代码格式检查通过；未运行真实浏览器输入、完整组件/项目类型或构建及组合 CI。候选仅交付独立功能分支，不创建 PR。见[输入修正记录](history/2026-10-08-task-label-ime.md)。

## 本轮独立候选：版本反馈转后续任务

2026-10-08按用户继续开发要求，在`c73be08`上独立补14-05：选择项目可见成果某个固定版本的一条反馈，带入同项目的新Task草稿，确认创建后才保存。既有待确认创建优先恢复原包，取消/导航不创建；来源变化清理未提交草稿，反馈过长不静默截断。私有成果入口暂不支持，来源是工作说明中的明确引用，不是新子任务/依赖关系。

本候选已通过7项纯函数测试、9组隔离React组件交互检查与定向源码转译/格式检查。组件检查使用真实React、实际NewTask及原创建控制器，外围Provider、UI与请求为显式替身，不能代表真实后端或浏览器。Chromium在启动时因socket权限失败，实际浏览器流程、完整类型/构建与全CI未运行；不影响上面的主线历史证据，也不把14-05整体改为完成。详细记录见[本轮记录](history/2026-10-08-result-feedback-followup.md)。

## 本轮独立候选：可选目标日期

在main `c73be08`上独立增加Task目标日期编辑/清除、详情/列表/看板展示和日期筛选。日期是0001–9999年的真实YYYY-MM-DD日历字符串；今天按浏览器本地日期，只有todo/in_progress且目标日在今天之前算逾期。本地午夜及恢复可见/聚焦会更新筛选。日期独立存储、仅人工读取投影，不写原Task JSON；普通PATCH沿用Task修订、原子回执与冲突恢复，新建表单不扩字段。

最终21项定向契约/真实SQLite与Store/筛选/PATCH回调检查、7项真实React组件交互通过，含真实v34→v35升级与旧无日期回执不漂移。无关服务构造、外围UI/state/client/排序是明确替身；不等于真实HTTP、浏览器或全模型链验证。完整类型/整仓构建/全CI和浏览器未运行。原04工作项仍部分实现，见[用法](../engineering/task-target-dates.md)与[验证记录](history/2026-10-08-task-target-dates.md)。

## 三切片独立整合候选

已按精确main `c73be08`重建标签IME、反馈后续任务与目标日期三个已交付分支，仅21/22的并列新增说明发生文本冲突，19自动合并；30个非共享改动文件保持各分支内容不变。本次只整合既有能力与验证边界，不新增功能或提高原工作项状态。

组合源码实际通过23项Store/SQLite、契约、筛选与PATCH回调检查（含2项跨切片接口）、7项日期React检查、5项IME事件检查、7项反馈纯函数、9组反馈React交互与4组跨切片React检查；IME定向严格类型/React事件兼容、修改源码独立转译及格式检查通过。交叉核对无日期/null/有日期来源均不改变后续任务原三字段创建体，创建回执保留原缺省日期形状、人工投影为null，后来日期修改不改变原创建回放；实际标签组件的IME确认与明确加入不干扰日期和反馈创建。

以上55项/组定向检查仍使用选定源码与明确外围替身：Store/SQLite及普通标签/参与代码为实际实现，无关业务服务构造为替身；React为实际组件/创建控制器/契约，state、Dialog和请求等外围为替身。没有真实HTTP服务器或浏览器验收，server类型/构建、整仓构建、全套测试与CI仍未运行。独立整合分支不代表已合入main，也不由此恢复暂停范围。

### 补齐完整Web静态验证（2026-10-08）

实际验证提交为`ab8c81e4fac2c904e969492c5771eccf1811babb`。新目录按该提交恢复198个所需文件，逐一核对Git blob SHA；735条import/资源引用完整解析，闭包仅Web/client/UI与共享契约/纯领域模块，不含db/control/runner实现。按原锁文件从npm官方源以`npm ci --ignore-scripts`安装依赖，未修改源码、配置或锁文件。

Node24.19.0下，直接执行原`tsc -p apps/web/tsconfig.json --noEmit`通过；原Vite8.3.1配置的`vite build --config apps/web/vite.config.ts`也通过，处理166个模块。未使用替身或排除文件来运行这两项完整Web检查，也未通过顶层脚本执行server。主JS为686.48kB（gzip194.98kB），超过默认500kB的是非阻断体积警告，构建退出0。随后文档补证提交`35b825e`仅修改21/22文档，当时生产/配置blob与实际编译版本保持一致。

前述各独立切片记录中的完整类型/构建未跑是其当时边界；当前统一候选已补齐完整Web类型与前端构建。server类型/构建、真实HTTP/浏览器/中文输入法、全工程/Playwright/CI仍未运行；静态编译不等于认证或文件操作诊断、功能执行或安全复核。

### 组件缺失日期投影输入保护

正常TaskPage经Store.detail/taskForRead已有日期投影，未证实用户正常入口实际丢日期。组件边界测试发现：输入缺失targetDate时，仅改说明可能把undefined变成null清掉存储日期。现编辑器保留缺失与明确空值区别，undefined在新请求中始终省略；明确null/日期仅在相对用户所选基线有变化时发送。原未知请求不重建，日期ACK只对原请求含日期时校验；原内容、修订、ownership和明确保留草稿语义保持。

最终新增19项真实React＋Store/SQLite回归及原55项/组全部通过，包含评审发现的“缺失日期草稿→较新有日期基线→明确保留草稿→保存”路径。完整原Web类型及Vite构建重新通过（166模块，JS686.61kB/gzip195.03kB，500kB非阻断体积提示仍在）；198个Web输入只改变编辑器，未改配置/锁文件。生产改动仅该编辑器，工程/历史说明见[目标日期](../engineering/task-target-dates.md)和[保护记录](history/2026-10-08-task-target-dates.md#整合候选补充组件缺失投影输入保护)。server、浏览器及全CI未跑，不把组件替身检查等同真实HTTP或普通入口事故。

## 当前源码能力与主线边界

| 范围 | 已接入的实际范围 | 仍需区分的限制 |
| --- | --- | --- |
| Workbench W1 | 现有页面完成重建，旧呈现层删除；深浅色、密度、窄屏、动效与输入/抽屉保护 | 桌面宿主/安装包未交付；演示不供给真实状态 |
| 项目与任务 | 创建、说明、状态、成果讨论、项目设置/归档、负责人/参与关系、原人员/状态/关注筛选、持久排序及项目Task标签 | 独立需求、子任务/依赖/里程碑、私有Task标签、项目级标签目录/级联和完整等待原因仍缺 |
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

## PR56—74 已验收范围与本次整合

| 范围 | 候选代码行为 | 验证与剩余边界 |
| --- | --- | --- |
| 工作说明编辑 | 固定 Task/修订/原文，外部变化只做冲突对照；明确载入新基线，同包同键确认未知 PATCH；事务内旧回执前复核当前编辑权 | 来源 [PR40](https://github.com/ntygod/HEXU/pull/40)；不含内容历史、独立 Requirement 或执行输入，见[用法](../engineering/task-edit-baseline.md) |
| 普通 Task 创建 | 本路由独立 96 KiB JSON 字节预算，容纳既有合法中文与全转义输入；标题/说明字符上限、原回执与原子事务保持，另补旧回执事务内当前空间/项目编辑权复核 | 来源 [PR41](https://github.com/ntygod/HEXU/pull/41)；全局及无关路由仍为原预算，无新 schema/迁移 |
| 重开与确认 | 已取消 Task 可从详情和固定成果重开；完成/取消确认跟随当前访问/编辑权和固定修订；详情取消读取同 Task 全部活动 Run 并明确 stop/keep | 来源 [PR48](https://github.com/ntygod/HEXU/pull/48)、[PR49](https://github.com/ntygod/HEXU/pull/49)、[PR50](https://github.com/ntygod/HEXU/pull/50)；Task 状态和真实执行终止分别判断 |
| 确认弹窗的未知结果恢复 | 完成/取消确认首次发送固定动作/正文/幂等键，关闭后同 Task 状态入口先恢复原包；有效成功 ACK 后读取失败只 GET 刷新 | PR56 已验收，来源 [PR55](https://github.com/ntygod/HEXU/pull/55)；另补 complete/cancel/reopen 旧回执事务内当前编辑权复核；Provider 内存按身份/空间隔离，当前撤权清除，不跨硬刷新，见[用法](../engineering/task-completion-confirmation.md) |
| 直接状态的原请求恢复 | start/reopen/无活动 complete 首次点击仍立即 POST；发送前固定原 Task/动作/正文/修订/键，只有未知结果或有效 ACK 后 GET 失败才显示恢复；所有同 Task 状态入口先恢复原包 | PR57 已验收、冻结未合并；start 只把 Task 标记为 in_progress，不启动 Run。复用上述 Provider/outcome/当前权限与 GET-only 路径，无新后端/API/schema，见[记录](history/2026-10-02-direct-task-status-recovery.md) |
| 普通创建的原请求恢复 | PR58在第一次 POST 前保存创建正文/幂等键；所有新建入口优先恢复同身份/空间中的未结原包，未知结果确认同一请求，有效 ACK 后只 GET；创建请求的旧身份/空间拒绝事件不会清掉新 Provider | PR58 已验收、冻结未合并；属于 04-01/03；Provider 临时内存不跨硬刷新，无后端/字段/schema/协议扩展，见[记录](history/2026-10-03-task-creation-request-recovery.md) |
| 账号/空间迟到响应 | 普通 HTTP 失效通知按发送时账号/空间代次隔离；旧身份查询及其调用者的导航不覆盖后来界面，当前拒绝继续清理 | PR59已验收并纳入本组合候选；原ApiError、服务端权限与原请求包保持，见[记录](history/2026-10-04-identity-late-response.md) |

上表前四项来源PR56，第五项PR57，第六项PR58，第七项PR59；PR60—74的项目筛选、工作台列表、搜索、成员任务视图、固定版本链接和持久排序已有来源验收记录。父PR56只从main提取必要的普通Task可靠性改动与PR33事务依赖，本组合候选仍不含旧链的原目录文件应用/恢复等功能；不把本轮组合验收作为旧文件链的安全结论。

## 模式与验证边界

- 默认 `preview` 是虚构单用户示例；mock 不启动命令或调用模型。显式配置的原生路径仍属实验接入。
- `team-local` 使用独立业务/认证数据库与真实权限，控制宿主不执行原生/mock 任务；只有本人明确授权的节点可接收执行。两种模式均只支持回环地址。
- 原生/节点完整工程回归以 Linux 为准；macOS 未实测，Windows 原生执行不支持。Web 页面通过不代表进程/凭证边界跨平台完成。
- 协议替身测试、官方程序无模型兼容检查、有效账户真实互操作是三类证据；前两类不能证明真实模型生成/费用/历史恢复。已核验工具版本和过程看历史及 [Claude](../engineering/claude-sessions.md) / [Codex](../engineering/codex-sessions.md) 说明。
- 完整跨成员代码接手、完整方案代码产物/扩展接续/整合、通用项目预览、外部 Git/PR 集成、模板/自动化、正式远程部署与安装升级仍待交付。项目仓库使用 GitHub/CI，不等于产品已经实现这些集成。

## 最近验证与交付位置

| 对象 | 实际证据与适用范围 |
| --- | --- |
| main `a3ae2e8` 基线 | [CI121 / 36658556183](https://github.com/ntygod/HEXU/actions/runs/36658556183)：596/596 工程通过、Chromium 123/124；固定成果版本 URL 用例 1 项失败。实际 trace 显示测试在 v2 加载时读到空选项，之后以未定义目标选择 v2；PR56 只修该用例的加载/固定 ID 前置条件，已由其 172/172 Chromium 验证，不更改该基线问题的成果生产逻辑 |
| 旧堆叠最终 [PR55](https://github.com/ntygod/HEXU/pull/55) `e977fb24` | [CI182 / 37042961842](https://github.com/ntygod/HEXU/actions/runs/37042961842)：1169/1169 工程、349/349 Chromium 与汇总通过；199/200 原图实际查看。只证明该完整堆叠 head，不覆盖本 main 候选 |
| 父 [PR56](https://github.com/ntygod/HEXU/pull/56) 冻结树 `96b7cb89` | 远端 head `a06998ab9035bb3164a271d77ec884204febfaad` 与本地 `cb650c5` 同树。[CI183 / 37051207701](https://github.com/ntygod/HEXU/actions/runs/37051207701)：工程 **618/618**、Chromium **172/172** 与汇总全部 success；107/108、201—211 共 13 张原图于 19:19 UTC 实际查看，PR 正文于 19:21 UTC 回读。草稿未合并，详细耗时、artifact 与早期本地失败见[父记录](history/2026-10-02-task-reliability-integration.md) |
| 父 [PR57](https://github.com/ntygod/HEXU/pull/57) 冻结树 `49c2d825` | head `0947dd5b238aab88947caebfe9d979005040c0e3`。[CI185 / 37101126911](https://github.com/ntygod/HEXU/actions/runs/37101126911) 的 engineering/browser/check 均终态 success；用户交接记录工程 **622/622**，浏览器日志复核 **199/199、17.4m**。精确 head 的 212—214 与 206/207/209/210/211 共 8 张原图于 2026-10-03 06:28 UTC 实际查看，PR 正文于 06:29:57 UTC 补充并回读；artifact 指纹与先前失败见[直接状态记录](history/2026-10-02-direct-task-status-recovery.md) |
| 父 [PR58](https://github.com/ntygod/HEXU/pull/58) 冻结树 `12682f6a` | head `7f7b9328033e48fbcde26be021e30d0ade9c51d8`。[CI188 / 37108859359](https://github.com/ntygod/HEXU/actions/runs/37108859359)：工程 **622/622**、Chromium **227/227、18.3m** 与汇总全绿；最终 215/216 原图于 2026-10-03 08:33 UTC 实际查看，PR 正文于 08:35 UTC 更新并回读。创建只保留内存原包，不跨硬刷新；首轮失败与修正保留在[记录](history/2026-10-03-task-creation-request-recovery.md) |
| 兄弟 [PR59](https://github.com/ntygod/HEXU/pull/59) `39334c8` | [CI190 / 37176559213](https://github.com/ntygod/HEXU/actions/runs/37176559213)：工程622/622、Chromium236/236和汇总全绿；新增9项真实账号迟到响应回归实际通过，包含当前拒绝对照与导航保留，见[记录](history/2026-10-04-identity-late-response.md) |
| 父 [PR60](https://github.com/ntygod/HEXU/pull/60) 冻结树 `12440955` | head `59ef20a7ae55ad6cfd77a2acc768e0d610a36cd5` 的 [CI192 / 37183505095](https://github.com/ntygod/HEXU/actions/runs/37183505095) 工程 **629/629**、Chromium **230/230、17.4m** 与汇总全绿；最终 217/218 于 2026-10-04 07:00 UTC 实际查看。项目状态筛选与取消只读导航已验收；首次测试断言失败与修正见[记录](history/2026-10-04-project-task-status-navigation.md)。最终 PR 验收正文曾被发布审核拒绝；获得用户明确许可后，2026-10-04 15:35 UTC 原正文更新成功并回读一致 |
| 父 [PR61](https://github.com/ntygod/HEXU/pull/61) 关注筛选 | head `017df91c6a497b8b9d75bd6b3243dd8d1e2516c8`、tree `6bdd38ffcf278932acac44fc79adc6d1d4d1a320`；[CI193 / 37213770407](https://github.com/ntygod/HEXU/actions/runs/37213770407) 工程 **637/637**、Chromium **233/233、18.8m** 与汇总全绿。219/220 原图于 16:00 UTC 实际查看；最终正文已更新并回读。详见[记录](history/2026-10-04-project-task-attention-filter.md) |
| 父 [PR62](https://github.com/ntygod/HEXU/pull/62) 版本固定链接 | head `928c2719c714e951833ec0989182fe6b400d43e6`、tree `ac4d149308edf89e3dbc51b5318390e74ed2952b`；[CI194 / 37215837307](https://github.com/ntygod/HEXU/actions/runs/37215837307) 工程 **637/637**、Chromium **234/234、17.2m** 与汇总全绿。221/222 和107/108 原图于 16:31 UTC 实际查看；最终正文已回读，见[记录](history/2026-10-04-result-version-link.md) |
| 父 [PR63](https://github.com/ntygod/HEXU/pull/63) 说明命中片段 | head `e3afb212312ed7cf3278947e67a5b7c1f624133b`、tree `d77f80e6086695b8d2cb2ab980c5c8de0d465127`；[CI196 / 37219902233](https://github.com/ntygod/HEXU/actions/runs/37219902233) 工程 **647/647**、Chromium **237/237、18.7m** 与汇总全绿。最终223/224和211原图于17:37 UTC实际查看；最终正文17:38 UTC更新并回读。首轮旧ACK测试失败和修正见[记录](history/2026-10-04-project-task-match-snippets.md) |
| 父[PR64](https://github.com/ntygod/HEXU/pull/64)工作台任务列表 | head `2d113c1cb22d17b3703d4d45b11545da7ccd3d8a`、tree `e7af20e8edeef0b6b0a71b1b75c6963e28479a0a`；[CI198 / 37224765060](https://github.com/ntygod/HEXU/actions/runs/37224765060)工程 **647/647**、Chromium **243/243、16.2m**与汇总全绿。228/229最终原图18:49 UTC实际查看，正文18:51 UTC更新并回读。首轮截图准备失败及修正见[记录](history/2026-10-04-workbench-task-list.md) |
| 父[PR65](https://github.com/ntygod/HEXU/pull/65)我参与的工作台入口 | head `9d0a17e8142621dd4d495ea09ead64a2a1f2a436`、tree `fd3b59bcbec2eecd20baad2302d4550766a070c9`；[CI199 / 37227168143](https://github.com/ntygod/HEXU/actions/runs/37227168143)工程 **650/650**、Chromium **246/246、16.5m**和汇总成功。最终230/231原图19:28 UTC实际查看，最终正文19:29 UTC更新并回读，见[记录](history/2026-10-04-workbench-participating.md) |
| 父[PR66](https://github.com/ntygod/HEXU/pull/66)取消个人任务找回 | head `e82b0a7185223a9c943b6ea1b67f93b12ea3ad61`、tree `f06e23837cd11887692e0018dc6af70866a5b0bc`；[CI201 / 37231321458](https://github.com/ntygod/HEXU/actions/runs/37231321458)工程 **650/650**、Chromium **249/249、19.5m**和汇总成功。最终232/233原图20:36 UTC实际查看，正文20:37 UTC更新并回读。首轮三夹具失败与修正见[记录](history/2026-10-04-workbench-cancelled-tasks.md) |
| 父PR67成果库查找 | 项目/关键词交集、当前成果与Task字段、来源/有界片段、URL恢复及预选项目入口；原详情与固定版本链接复用。[CI202](https://github.com/ntygod/HEXU/actions/runs/37234521020)工程661/661、Chromium254/254及汇总成功；234/235原图已查看，最终正文已回读，见[记录](history/2026-10-04-result-library-search.md) |
| 父PR68 Task搜索分页 | 原当前可见Task集合/顺序，每页30项，查询/当前序列绑定与失效重搜；[CI204](https://github.com/ntygod/HEXU/actions/runs/37240032813)672/672工程、259/259Chromium与汇总成功，236/237最终原图和正文回读已完成；首轮手机滚动末端留白修正见[记录](history/2026-10-04-task-search-pagination.md) |
| 父PR69 Task范围与来源查找 | 默认全部、项目或无项目范围在分页前交集；当前来源/修订及正文片段解释结果。[CI205](https://github.com/ntygod/HEXU/actions/runs/37242868500)688/688工程、263/263Chromium和汇总成功，238/239及236/237原图和最终正文回读已完成，见[记录](history/2026-10-04-task-search-scope.md) |
| 父PR70当前Result全局查找 | 显式Task/Result类型，当前范围、30项分页及来源/版本/正文命中；[CI206](https://github.com/ntygod/HEXU/actions/runs/37246291505)699/699工程、268/268Chromium和汇总成功，240/241及236–239原图和最终正文回读已完成，见[记录](history/2026-10-04-current-result-search.md) |
| 父PR71成员工作浏览 | 工作台成员目录与当前空间成员地址，负责/明确参与Task并集、来源/关系和8项逐批，沿原Task详情；[CI208](https://github.com/ntygod/HEXU/actions/runs/37251716184)707/707工程、271/271Chromium和汇总成功，242/243及228–231原图与最终正文回读完成，见[记录](history/2026-10-05-member-work-view.md) |
| 父PR72当前项目约定查找 | head `6c99012237ce03ec0f18841f6b464c9b5d5c8454`、tree `ed28500e34479a0f07a83ae0e20957f14e27d418`；[CI209](https://github.com/ntygod/HEXU/actions/runs/37255633314)工程721/721、Chromium276/276与汇总成功；244–246和同head236/237/240/241实际查看，最终正文已回读，见[记录](history/2026-10-05-current-agreement-search.md#精确提交验收)。 |
| 父PR73固定版本报告/发布链接 | 独立手动引用、原父Task读/编辑、固定原请求恢复和未知外部状态；[CI212](https://github.com/ntygod/HEXU/actions/runs/37269337046)729/729工程、288/288Chromium与汇总成功，247–250/107108/221222八张最终图与正文回读完成。14-06三条原条件合验完成，先前失败与修正见[记录](history/2026-10-05-result-reference-links.md#精确提交验收)。 |
| 父PR74项目任务持久排序 | 最终head `93eadbf2` 的[CI214](https://github.com/ntygod/HEXU/actions/runs/37278899781)：工程746/746、Chromium303/303、22.6m与汇总全绿；251—253及父级6张原图的验收记录在其PR正文。首轮实际拖动夹具失败及修正保留在[记录](history/2026-10-05-project-task-order.md)。 |

旧链25个草稿PR（#29—#51、#54、#55）包含与新链重叠及尚有问题52的功能；本轮处理方案及归档引用见整合PR。正式个人客户端、远程团队服务与有效账户provider互操作仍缺，合并与分支清理不改变这些边界。

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

2026-10-03 CI186 补记：首轮创建恢复 head `d202f72a` 的工程 622/622 通过，浏览器在共用项目选择器出现连续 18 项超时，开始第 173/227 条后取消。已按实际 trace/失败图修正精确角色定位、保留原错误的清理和本 spec 失败制品匹配；生产代码不变，完整新 head 与 215/216 实图仍待验收，见[本轮记录](history/2026-10-03-task-creation-request-recovery.md#ci186修正新测试的项目选择器)。

CI187 历史补记（最终 CI188 见上表）：`11eaddbd` 的工程 622/622、Chromium 227/227 和汇总全绿；215/216 与 212/213 四张精确 head 原图已查看。锁定值在实际浅色图中偏淡，当前只补创建表单内正文色/不透明度，保留 disabled 和全部请求语义；最终新样式的完整 CI 与同两图仍待验收，见[可读性记录](history/2026-10-03-task-creation-request-recovery.md#ci187全套通过后修正冻结值可读性)。

## 进度口径与更新

原 102 行按本候选实际状态统计为 **3 完成 / 80 部分实现 / 19 未实现**。PR68/69/70/72已闭合15-04的Task分页/范围/来源、当前Result和项目约定全局查找子条件；PR71已使15-06成员工作由未实现转为部分实现。15-04仍欠需求/消息等资源，整项仍部分实现；14-06已按手动可选引用、原项目成果列表和完成一致性三条原条件验收完成。旧堆叠2/80/20不适用于本候选；本次统计来自逐行真实实现及验收，不增加原条件之外的自动集成门槛。13-04已有比较/选择及干净固定提交的新会话接续；13-05已有固定源/目标与完整对象只读预检，实际应用和冲突解决仍缺。方案等待/原生恢复、脏现场、AI差异建议及完整代码产物仍待补齐。其他原项仍有完整历史、自动编排、跨平台/跨电脑等剩余范围。工作项大小不同，不能折算产品完成百分比。

能力及验证更新本页和 19；下一项只改 22；用法放工程指南，开发约束放相应 harness。不会根据节点连通、协议替身或历史报告声称跨电脑产品或真实模型联调完成。

## 2026-10-08 身份、能力与独立只读连接候选增量

本节追加到普通候选原文，上述既有章节与统计保留其对应时期含义。当前按19实际102行为 **3完成 / 82部分实现 / 17未实现**；16-04/16-06新增有限子集，未将任何整项提高为完成。

- 已编写：本人多Agent登记/撤销、HTTPS端点元数据、固定文本能力/不可变版本、按项目/参与者过滤的有限预授权与能力选择；Task负责人和AgentProfile不变。
- 独立Agent连接：hash-only、一次响应返回凭据、固定ID轮换撤销、最长24小时单项目capability_read；只开放独立身份与项目能力目录GET。端点更新、项目/空间撤权或归档永久撤旧代，重入/恢复不复活；不能拿Cookie、节点标记或空间覆盖伪造Agent。
- 最小UI：资源登记、端点/能力编辑、有限授权、连接显式创建/轮换/撤销、项目目录选择。选择只复核固定标识，不创建协作或发送材料；未知请求原包/原键跨资源路由保留，权限变化与身份切换清理。
- 已有实际检查：15项React组件检查、原Web TypeScript全量静态检查、原Vite生产构建（172模块）、UI tokens检查通过。后端18项SQLite/PermissionService/Fastify.inject检查与按原server全部flags的定向编译通过；另有4项实际UI→client→Fastify.inject→SQLite/PermissionService业务桥接通过，业务响应无替身。三组检查分别计数，详见历史。
- 限制：React检查使用useApp/Button/fetch/FormData替身及react-test-renderer19，不是DOM、键盘焦点、真实浏览器；后端是显式Principal隔离夹具，不等于Better Auth或完整control启动/全server类型检查。桥接仅App/请求身份、Button/FormData为夹具，fetch是无listener运输，不等于真实网络或Better Auth。浏览器、整仓构建与full CI未跑。Vite仍有非阻断大于500kB bundle提示。
- 未实现/未验证：MCP/A2A桥、实际接收、双向请求/澄清、结果消费、真实客户端、跨设备与远程模型/部署。目录保持callable=false；独立能力读取不等于请求/执行或双Agent自主协作。没有真实账号激活或付费外连。

细节与前置版本探测见[本轮记录](history/2026-10-08-agent-capability-entry.md)；下一项只看[22](22-next-delivery.md)。本候选仍待运行/界面补验，不以旧PR77或原普通候选通过记录替代新增代码验证。
