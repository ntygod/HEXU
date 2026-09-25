from pathlib import Path
import re
from collections import Counter

marker = Path('.staging/applied-02')
if marker.exists():
    raise SystemExit(0)
# D covers the original item's complete narrow scope, not its entire work package.
# P never implies production readiness. N means no usable implementation, not no specification.
groups = {
1: [
'P 实际采用 React/Vite、Fastify、TypeScript、npm 和锁文件；正式存储/认证选型、完整许可证与升级维护仍需收口。',
'D 应用与共享包、环境样例、统一启动/构建/类型检查入口已建立；本项仅工程骨架，不包含独立 Runner。',
'P 本机 HTTP、DTO、错误码、运行和接续契约已落地；远程节点协议、完整权限 schema 与类型生成未完成。',
'P SQLite 迁移、事务、outbox 与接续原子关联已实现；PostgreSQL 和附件存储端口未实现。',
'P 虚构数据及成功/失败/输入/授权模拟流程已实现；节点失联、缺模型等完整场景集和生产隔离仍需完善。',
'P 本机构建、health/ready 与只读 CI 已有；正式数据库/文件服务的自托管组合与配置诊断未完整实现。',
],
2: [
'P 浅深色、颜色与状态变量已实现；字体、间距等仍有页面硬编码，完整语义 tokens 与使用说明未收口。',
'P 导航、路由与项目快捷入口已有；空间固定为示例，真实空间切换未实现。',
'P 任务、执行、人物/工具、成果组件已有；完整上下文引用与全部状态示例未完成。',
'D 工作台、项目、任务和成果四类页面骨架已接统一示例数据并可交互；此完成状态仅指页面骨架。',
'P 继续、反馈与回复界面已有，E1c 增加接续状态卡；协助和并行面板未实现。',
'P 窄屏、浅深色、搜索/弹层键盘路径及部分异常状态已有；布局偏好、历史阅读保护与完整文案字典未完成。',
],
3: [
'N 固定示例身份不是登录；成熟认证组件、IdentityPort 与会话恢复未实现。',
'N 示例成员不是成员系统；真实空间、成员邀请和加入流程未实现。',
'P 已有示例主体的任务可见性过滤与本机请求边界；没有真实会话、项目角色与统一资源授权。',
'P 项目创建和读取已实现；仓库引用、项目成员配置与权限未实现。',
'N 默认示例体验不是个人/团队渐进入门向导。',
'N 成员撤销、项目归档及其权限事件未实现。',
],
4: [
'P Task、本机归属、修订和持久化已实现；正式成员归属、完整项目/个人权限尚缺。',
'P 完成/重开/取消与活动执行的后端联动已有；完整动作 UI 与多人权限仍需收口。',
'P 列表、看板、关键词查找和等待原因展示已有；完整排序与成员/等待原因组合筛选未完成。',
'N 可编辑 Task 说明不等于独立需求模型；Requirement 修订和局部采用未实现。',
'N 子任务、依赖、可维护标签和里程碑未实现。',
'P 项目/个人 Task 共用 DTO 和创建流程；完整个人入口、归属切换与权限未完成。',
],
5: [
'P 任务消息和成果回复已持久化；线程、提及及附件关联未完成。',
'N 项目资料独立模型、资料修订和来源管理未实现。',
'N 从讨论保存共享团队约定未实现。',
'N AI 草稿及局部编辑/采用流程未实现。',
'P 任务说明、近期记录与有界 Git 摘录可装配；完整按权限/目的选材的 ContextBundle 未实现。',
'P 可查看执行/接续上下文；运行中送达状态、项目资料引用与总结接入未实现。',
],
6: [
'N apps/runner 仍由本机 API 托管；独立 Runner CLI、配对和节点身份未实现。',
'N 节点主动连接、心跳、离线 spool 和确认重放未实现；本地 outbox 不冒充远程协议。',
'P 显式 Git 根、WorkingCopy、路径限制和实际 Git 状态已有；完整跨平台与节点授权未完成。',
'P 本机写入互斥和接续预约已有；独立代码工作区/分支隔离与远程资源登记未实现。',
'P POSIX 进程组、输出与有界取消已有；原生运行中输入、Windows 和跨平台实测未完成。',
'P 能力探测、重启未知状态、离线人工恢复已有；独立节点对账、完整诊断与升级恢复未完成。',
],
7: [
'P Run、配置快照、状态规则已有；主执行/协助/并行的完整统一模型未完成。',
'P 本机幂等写、接续预约与启动关联原子化已实现；独立节点持久化派发与 ACK 未实现。',
'P 归一化本机事件、游标、SSE 与示例访问过滤已有；真实会话权限和远程事件通道未完成。',
'P 模拟输入/授权回复可用；原生运行中输入与下一轮要求队列未实现，接续队列不是输入队列。',
'P 模拟授权与原生额外请求默认拒绝已有；真实动作绑定授权问答尚未实现。',
'P 本机停止、目录互斥、未知状态保锁及接续取消竞态已有；跨节点停止/恢复与平台覆盖未完成。',
],
8: [
'P CLI 路径、必要参数探测和独立 API 配置已有；其他账号方式与有效账户联调未完成。',
'P 受限 CLI 启动和 JSONL 结构流已实现；实际提供方生成尚未联调，流程检查使用协议替身。',
'P 原生 session 引用已记录；同工具 resume/恢复映射未实现。',
'N 原生运行中输入、澄清和完整权限桥接未实现；默认拒绝额外请求不算完成。',
'P 实际进程停止、超时与错误保留已有；完整提供方失败降级与跨平台恢复未完成。',
'P 原生结果、用量来源及本机预算配置已有；真实费用核对、完整资源配置与账户能力未验证。',
],
9: [
'P 本机 stdio、握手与能力探测已有，既有官方无模型检查有记录；完整版本兼容矩阵未完成。',
'P 新 thread/turn 和引用隔离已实现；原生会话恢复未实现。',
'P 事件、增量、结果和异常映射已有；真实提供方生成未联调。',
'P 模型目录与额外反向请求拒绝已有；实时输入、steer 与完整授权交互未实现。',
'P 中断、超时和本机未知状态处理已有；原生重连/恢复对账未完成。',
'P 用量来源、隔离配置和限制文案已有；真实计费及完整账户可用性未验证。',
],
10: [
'P TaskDetail、任务/执行双状态头及布局已有；真实团队访问范围未实现。',
'P 协作消息、本机事件和错误提示已有；历史分页、草稿恢复与完整发送状态未完成。',
'P 双工具/模型、本机开始、停止和持久化接续已有；远程节点选择与原生运行输入未实现。',
'P 实际 Git 文件差异已有；完整文件树、不可变成果快照和外部 IDE 衔接未实现。',
'N 带输入权的受控交互终端、重连和会话清理未实现。',
'P 上下文与成果插槽、接续恢复卡已有；协助卡和完整多面板异常状态未完成。',
],
11: [
'P E1c 新增 202 Operation、预检原因、幂等、刷新查询和本机预约；完整共享上下文选择及真实权限未实现。',
'P E1c 新增等待/请求停止后自动接续、原子 Run 关联和取消保护；原生 resume、跨节点和真实模型联调仍缺。',
'N Assistance、固定协助快照与有限 AccessGrant 未实现；依赖 03 的真实权限基础。',
'N 真人协助回复、AI assist Run 和独立只读/隔离协助流程未实现。',
'P E1c 继续抽屉、处理原执行选项和持久化进度卡已实现；协助抽屉与就地回应未实现。',
'N 协助的采纳/追问/取消与旧快照提示未实现；本轮接续取消不冒充协助工作项完成。',
],
12: [
'N 多仓库不可变检查点与补丁封装未实现；当前 Git 摘录不是可恢复检查点。',
'N 检查点传输和目标机器恢复未实现。',
'N Handoff 发布、接受与生命周期未实现。',
'N 选择性分享与跨空间明确发布未实现。',
'N 跨成员接手卡及可选责任转移未实现。',
'N 接手刷新恢复和部分失败处理未实现。',
],
13: [
'N WorkBranch 与共同起点模型未实现。',
'N 分支独立现场和并发代码执行未实现。',
'N 分支成果绑定与部分失败处理未实现。',
'N 方案对比和选择某分支继续未实现。',
'N 固定版本的选择性代码整合未实现。',
'N 分支停止、丢弃与清理保护未实现。',
],
14: [
'P 基础 Result、文字成果和来源关联已有；不可变 Revision 与完整产物模型未实现。',
'P 成果卡、页面和创建说明已有；版本历史与成果说明修订编辑未完成。',
'N 通用预览会话与主动隧道未实现；订单示例页不是用户项目预览。',
'N 独立预览身份、授权失效与真实预览回退未实现。',
'P 成果评论与回复已持久化；固定版本反馈和由反馈生成后续任务未完成。',
'N 可选报告、发布引用与成果完成整合未实现；无需报告即可完成任务已在 04 范围实现。',
],
15: [
'P 本机工作台和项目聚合查询已有；完整多人可见性与团队查询未实现。',
'P 工作台、等待提示和成果视图已有；真实协助/接手待回复聚合未完成。',
'N 通知投影、去重和个人偏好未实现。',
'P 任务中文关键词匹配和示例可见性过滤已有；跨实体搜索与真实权限未完成。',
'P 原生用量事件和费用来源说明已有；计量账本、统一去重聚合和预算提示未完成。',
'N 完整费用面板、真实成员工作与统一陈旧状态界面未实现；示例成员和局部 Run 状态不算完成。',
],
16: [
'N 协作模板、版本和步骤编辑未实现。',
'N 模板实例调度和普通 Run 复用未实现。',
'N 模板实例继续、跳过与取消未实现。',
'N 外部连接器、引用及 Git/PR 产品集成未实现；开发仓库托管在 GitHub 不算产品集成。',
'N 外部 Webhook、去重与可选自动完成未实现。',
'N 可选 CI/发布/通知产品集成未实现；开发 CI 不算产品业务功能。',
],
17: [
'N 面向团队的自托管安装、HTTPS 和初始化未实现；本机启动不是公网部署。',
'N 团队远程节点和受控运行环境未实现。',
'N 远程预览、端口与临时资源治理未实现。',
'N Runner 分发、升级与回退未实现。',
'N 正式备份恢复、生产迁移和多节点对账未实现；本地 SQLite 迁移归属 01。',
'N 运维诊断、脱敏导出与保留策略未实现。',
],
}
evidence = {
1: '[工程](../../package.json) / [迁移](../../packages/db/src/schema.ts)',
2: '[界面](../../apps/web/src/App.tsx) / [变量](../../packages/ui/src/tokens.css)',
3: '[本机存储](../../packages/db/src/store.ts)',
4: '[任务](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx)',
5: '[消息](../../packages/db/src/store.ts) / [上下文](../../apps/runner/src/runtime.ts)',
6: '[现场](../../apps/runner/src/workspaces.ts) / [进程](../../apps/runner/src/process-host.ts)',
7: '[状态/事务](../../packages/db/src/store.ts) / [接口](../../apps/control/src/app.ts)',
8: '[Claude](../../packages/adapters/claude-code/src/index.ts) / [宿主](../../apps/runner/src/runtime.ts)',
9: '[Codex](../../packages/adapters/codex/src/index.ts) / [宿主](../../apps/runner/src/codex-host.ts)',
10: '[任务页面](../../apps/web/src/App.tsx) / [原生面板](../../apps/web/src/native.tsx)',
11: '[Operation](../../packages/db/src/continuations.ts) / [协调器](../../apps/runner/src/continuations.ts) / [界面](../../apps/web/src/continuations.tsx)',
14: '[成果](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx)',
15: '[查询](../../apps/control/src/app.ts) / [工作台](../../apps/web/src/App.tsx)',
}
assert len(groups) == 17 and all(len(v) == 6 for v in groups.values())
counts = Counter(v[0] for values in groups.values() for v in values)
labels = {'D': '已完成', 'P': '部分实现', 'N': '未实现'}
p = Path('docs/development/19-work-items.md')
s = p.read_text()
pattern = re.compile(r'^\| (HX-DEV-(\d\d)-(\d\d)) \| ([^|]+) \| ([^|]+) \|$', re.M)
assert len(pattern.findall(s)) == 102

def row(match):
    key, g, i, title, role = match.groups()
    item = groups[int(g)][int(i)-1]
    proof = evidence.get(int(g), '—') if item[0] != 'N' else '—（尚无可用实现）'
    return f'| {key} | {title.strip()} | {role.strip()} | {labels[item[0]]} | {item[2:]} | {proof} |'
s = pattern.sub(row, s)
s = s.replace('| ID | 工作项 | 主职责 |\n| --- | --- | --- |', '| ID | 工作项 | 主职责 | 当前状态 | 实际范围与剩余工作 | 代码证据入口 |\n| --- | --- | --- | --- | --- | --- |')
s = s.replace('> **已开始 E0 开发。当前已实现、部分实现和未实现范围见 [21｜实现进度](21-implementation-status.md)，本页保留完整工作项定义，不宣称整包完成。**', '> **2026-09-26（UTC+8）逐项核对，E1c。保留原 102 个编号与标题，新增实际状态、剩余范围和代码入口。工程检查与当前边界见 [21｜实现进度](21-implementation-status.md)。**')
s = s.replace('认领时记录负责人、分支、前置项和当前障碍；实现进度引用 21，不把模拟能力算作原生适配完成。', '认领时记录负责人、分支、前置项和当前障碍；本页维护逐项状态，21 维护本轮增量与工程记录，不把模拟能力算作原生适配完成。')
summary = f'''## 状态口径与本次核对

按原工作项完整定义记录：**已完成 {counts['D']} 项、部分实现 {counts['P']} 项、未实现 {counts['N']} 项，共 102 项**。这些工作项大小不同，不能将条目数换算为产品完成百分比。

“已完成”仅指对应条目的窄范围；“部分实现”必须同时阅读剩余内容。原生流程检查仍使用协议替身，真实模型生成未联调。M0—M4 是完整产品阶段，E0/E1a/E1b/E1c 是实际代码批次，二者不互相替代。

本轮推进 **11-01、11-02、11-05** 的持久化接续切片，并补及 01-04、07-02、07-06、10 的相关部分。**不是执行完前十包，也没有进入 11-03 的真实协助。** 后续依赖和选择见 [下一步交付](22-next-delivery.md)。

'''
s = s.replace('## 2. 工作项索引\n', summary + '## 2. 工作项索引\n')
s = s.replace('首批 E0 已建立核心页面和本地数据流程，下一组工作转向身份、正式存储与独立执行器，详见 21。', 'E0—E1c 已建立本机页面、双工具和持久化接续切片；下一组补身份、正式存储与独立执行器，不能将临时协助提前伪装为多人协作。')
# Replace outdated batch notes, keeping full definitions and the original example intact.
if '\n## E1a 增量记录' in s:
    s = s.split('\n## E1a 增量记录')[0] + '''\n## 批次记录

E1a 推进本机目录/Git/进程与 Claude；E1b 推进 Codex 和显式跨工具继续；E1c 推进持久化接续、等待/停止、刷新、取消与重启保护。历史工程结果在 Git 历史与 21 中保留。所有状态以原条目完整范围为依据，不以本轮新增按钮数或测试数代表完成。
'''
p.write_text(s)

Path('docs/development/21-implementation-status.md').write_text('''# 21｜当前实现进度

更新：2026-09-26（UTC+8）。阶段：**E1c 本机持久化接续与逐项进度回填**。产品 v1.1 和 D1 的完整目标不变。

## 任务清单实际位置

[19｜102 项工作清单](19-work-items.md)已逐项补齐状态、剩余范围与代码入口。E1c 继续推进 `HX-DEV-11-01 / 11-02 / 11-05` 的本机切片，关联 `01-04 / 07-02 / 07-06 / 10`；三个 11 工作项仍是部分实现，没有把协助、原生 resume 或团队权限算作完成。

## 本轮实际增量

1. 新增持久化 ContinuationOperation。`POST /tasks/:taskId/continuations` 返回 **202 + Operation** 与 Location；查询单个操作和任务最近 20 个操作支持刷新恢复。
2. 用户可选择等待原执行自然结束，或请求停止后继续。只有收到确认终态且目录锁释放，才在同一任务/目录创建目标工具的新 Run；等待期间不启动第二个写入者。
3. 任务和目录有接续预约。重复点击、同键不同内容、直接 Run 请求抢占、准备期间取消、启动后的误取消都有明确处理。
4. 新 Run、目录锁、幂等记录及 Operation→Run 关联在同一事务提交，再启动进程。取消在最后一次事务检查中仍能阻止尚未创建的 Run。
5. 真正开始前重查任务修订、来源、目录和人工上下文。人工要求变化、原进程未知、目标不可用、等待过期转为“需要处理”；保留原要求和配置，不静默重试、不放开锁、不改换账户。
6. 页面增加“准备接续”、停止/等待选项、持久化状态卡、取消与保留要求的历史。Operation 的 succeeded 表示新 Run 已创建，不表示模型或任务成功。

停止/等待是已明确授权的本机动作，不是强制业务审批。完成任务仍不要求报告或测试证据。

## 不变的边界

| 内容 | 当前状态 |
| --- | --- |
| 本机项目、任务、讨论、成果、SQLite、浅深色 UI | 保留；不是正式多人服务 |
| Claude / Codex、本机跨工具新会话 | 实验性原生适配，默认关闭 |
| 有效提供方账户下真实模型生成 | **尚未联调，本轮没有调用真实模型** |
| 同工具原生 resume、运行中追加、完整授权问答 | 未实现 |
| 临时协助、成员接手、并行分支 | 未实现 |
| 多人登录、PostgreSQL、独立 Runner、远程预览 | 未实现；继续限制本机访问 |
| 进程未知与服务重启 | 保留现场与实际目录锁；待接续操作需要人工重新配置，不自动恢复付费执行 |

接续保存的是明确目标配置与来源，不迁移模型内部状态。原执行输出和 Git 摘录在停止后按既有上限重新整理；不是不可变检查点，也不是跨机器恢复。

## 工程检查记录

**本轮结果尚未登记；以具体 CI 记录为准。** 新增测试覆盖持久化、取消竞态、原子回滚、上下文变化、重复请求、未知进程、超时、实际协议替身进程和浏览器流程。测试定义存在不等于已经通过。

上一轮 E1b 主分支 `a1ee850` 的 CI [36160297019](https://github.com/ntygod/HEXU/actions/runs/36160297019) 已通过；记录为 56 条工程测试、14 条 Chromium 流程。官方 Codex 0.157.0 的 initialize/config 无模型检查是上一轮结果，本轮未据此声称真实账户生成已验证。

本轮本地容器无法解析 GitHub 域名，源码读取/写入经 GitHub 连接器，工程执行在 GitHub-hosted runner；不计为本地测试通过。开发分支临时集成脚本和写入式工作流不进入主分支，主分支保持只读 CI。

## 下一步

先把本轮接续切片收口，随后回补 03 身份与权限、01 正式存储、06 独立执行器基础；不直接进入依赖 AccessGrant 的 11-03。具体范围见 [22｜下一步交付](22-next-delivery.md)。
''')

Path('docs/development/22-next-delivery.md').write_text('''# 22｜下一步交付：先收口接续，再补真实团队基础

日期：2026-09-26（UTC+8）。对应产品 v1.1 / D1，不新增产品审批环节。

## 为什么本轮先做 E1c

E1b 已有双工具与同目录接续，但用户遇到活动执行时必须手动停止、等待、重开面板。原计划 11-01/02 明确要求 Operation 与 waiting_for_stop。这是已有主路径上的具体缺口，可以复用当前 Task/Run/WorkingCopy，而不引入另一套演示功能。

本轮交付持久化接续的完整本机纵向切片：动作、数据库、协调器、页面、恢复和必要回归。没有凭证也能检查进程控制和数据语义，但不能因此声称真实模型已经可用；真实账户联调仍单列未完成。

没有选择直接做 11-03：有限协助快照和 AccessGrant 依赖 03 的真实身份/权限。没有基础就先做“请同事协助”，只会把固定示例身份包装成多人协作。并行和跨机器接手也不能越过独立工作区与节点身份。

## 接下来主线：E2a 身份、空间与可见性

优先顺序为 `03-01 → 03-02/03-03 → 03-04`，并与 `01-04` 正式存储适配对齐。目标不是把现有服务改成 0.0.0.0，而是让两名真实成员以不同会话进入同一项目，能够协作且不能访问未授权资源。

交付范围：成熟认证组件经 IdentityPort 接入；会话建立/失效/恢复；空间与邀请；个人任务与项目任务的统一访问策略；项目成员权限；Task、Run、Result、Operation、搜索和 SSE 共用权限判断。保留现有任务记录和 ID，不另建“团队任务”模型。数据库迁移和旧 SQLite 数据保留/导入策略明确后再启用正式模式，不能清库替代迁移。

认证方案及依赖版本需在开工时按官方资料核对，不自行设计密码学。共享控制服务不能继承当前机器全部本地 Git 根和模型账户：远程用户访问和本机执行之间必须有节点身份、项目授权及逐次执行边界。

## 随后 E2b：成员电脑作为独立节点

推进 `06-01 / 06-02 / 06-04 / 06-06` 和 `07-02/03/06` 的远程部分。Runner 主动连接、配对、心跳、spool/ACK、断线重放及受管工作区授权先形成真实路径。控制服务只协调，不取得其他人的本机文件或模型密钥。

届时再进入 `11-03/04` 临时协助和 `12` 接手；没有可靠只读环境时，AI 协助仅使用选择的文字快照，不把 prompt 中的“不要改代码”当权限控制。

## 保持清晰的未完成项

真实模型联调、原生 resume/steer、完整授权交互、通用预览和终端仍独立跟踪。可以在授权的非敏感测试仓库中做提供方联调，但不把 API key 写进仓库、任务或公共 CI；没有账户结果就保持“未验证”。

UI 随纵向功能一起交付，继续使用现有浅深色与任务工作区布局。团队质量与实际效果评估由内部安排；工程回归不转换成产品里的强制验收流程。
''')

p = Path('docs/development/11-continuation-assistance.md')
s = p.read_text().split('\n## E1b 当前实现子集')[0]
p.write_text(s + '''\n## E1c 当前实现子集

`POST /tasks/:taskId/continuations` 现返回 **202 + 持久化 Operation**；必须显式选择 `onActiveRun=wait/request_stop`。`GET /operations/:id`、`GET /tasks/:taskId/continuations` 与带 expectedRevision/幂等键的 `POST /operations/:id/cancel` 已接入。E1b 返回 201+Run 的旧接续契约已经迁移；普通 `/runs` 创建仍返回 201，且同样受接续预约保护。

同机双向跨工具继续支持等待/停止、刷新、取消、启动前重查和事务关联。原进程未知不释放目录锁；重启将待接续操作转为需要处理，保留要求但不自动启动。任务修订或人工上下文变化采取保守阻止，标题变化也需要重新配置；这不是最终的细粒度影响判定。

11-01/02/05 仍为部分实现：没有完整共享上下文选择、团队权限、同工具原生 resume 或协助面板。11-03/04/06 尚未实现，本轮接续取消不计作协助取消。真实模型生成仍未联调。工程结果见 [21](21-implementation-status.md)，逐项状态见 [19](19-work-items.md)。
''')
p = Path('README.md')
s = p.read_text().replace('E1b 本机双工具与跨工具继续', 'E1c 本机持久化接续').replace('E1b 不开放', 'E1c 不开放')
s = s.replace('原执行未停止、目录占用或来源已更新时不会强行启动；先停止并确认，再继续。', '原执行仍活动时可选择“请求停止后继续”或“自然结束后继续”，安排会保存并可取消。只有确认停止且目录释放后才开始；任务说明变化、原进程未知或服务重启会提示处理，不会强行启动。')
s = s.replace('| 同机跨工具继续 |', '| 持久化接续 | 等待/请求停止后继续、刷新恢复、取消及需要处理提示；不把新执行创建当作任务完成 |\n| 同机跨工具继续 |')
s = s.replace('| [当前实现进度](docs/development/21-implementation-status.md)', '| [逐项任务状态](docs/development/19-work-items.md) | 原 102 项的真实状态、代码入口和剩余内容 |\n| [下一步交付](docs/development/22-next-delivery.md) | 收口接续后补真实身份、权限与独立节点 |\n| [当前实现进度](docs/development/21-implementation-status.md)')
p.write_text(s)
p = Path('AGENTS.md')
s = p.read_text().replace('E1b remains', 'E1c remains')
s += '''\n## Durable continuation\n\nContinuationOperation is distinct from both Task and Run. Its succeeded state means a Run was committed, not successful model work. Keep pending task/working-copy reservations and check them in every start route. Commit the Run, working-copy lock, idempotency result and operation link atomically before spawning. Recheck cancellation and human context immediately before commit. A stop request is not termination confirmation. On restart keep unknown process locks and mark pending operations needs_attention; never automatically replay paid execution. Preserve every original work-item ID and maintain the state/evidence/remaining columns in docs/development/19-work-items.md.\n'''
p.write_text(s)
print('102-item audit:', dict(counts))
marker.write_text('E1c progress audit applied. Development-only marker.\n')
