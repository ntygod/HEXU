from pathlib import Path
import re
from collections import Counter
marker = Path('.staging/applied-02')
if marker.exists(): raise SystemExit(0)

def append(path, content):
    p=Path(path); p.write_text(p.read_text() + content)

updates = {
'01-01': ('React/Vite、Fastify、TypeScript 与锁文件已有；E2a 固定 Better Auth 1.7.6，经 IdentityPort 接入。正式存储适配、完整许可证与升级维护仍待收口。', '[工程](../../package.json) / [认证](../../packages/identity/src/index.ts)'),
'01-04': ('SQLite 迁移 4、事务/outbox、接续原子关联与账号模式隔离已有；PostgreSQL、附件存储端口和旧预览到正式团队的导入未实现。', '[迁移](../../packages/db/src/schema.ts)'),
'02-02': ('导航、项目入口及真实个人/团队空间切换已实现，切换清理旧页面缓存；完整工作偏好与其他入口仍待完善。', '[身份界面](../../apps/web/src/identity.tsx) / [外壳](../../apps/web/src/App.tsx)'),
'03-01': ('Better Auth 真实密码账号、初始化代码、登录/退出、改密、会话恢复及撤销已实现；邮件验证、忘记密码恢复、SSO 和正式部署未接入。', '[认证](../../packages/identity/src/index.ts) / [界面](../../apps/web/src/identity.tsx)'),
'03-02': ('真实个人/团队空间、绑定邮箱的邀请、接受/撤销/过期与成员退出/移除已有；无邮件发送、完整空间角色管理与所有者转移。', '[协作数据](../../packages/db/src/collaboration.ts) / [空间](../../apps/web/src/team.tsx)'),
'03-03': ('服务端统一项目 view/edit/manage 与私有任务权限，覆盖直接 ID、列表、搜索、SSE、成果与 Run/Operation；权限检查先于幂等重放。通用 AccessGrant、附件及远程节点授权未实现。', '[权限](../../packages/db/src/permissions.ts) / [接口](../../apps/control/src/identity.ts)'),
'03-04': ('真实空间中的项目创建、读取、成员添加/移除及角色配置已实现；项目编辑/归档、仓库引用与完整目标配置尚缺。', '[项目成员](../../packages/db/src/collaboration.ts) / [界面](../../apps/web/src/team.tsx)'),
'03-05': ('建立首个账号后直接进入个人空间，可建团队、邀请和加入，真实界面已有；独立节点连接与完整渐进入门偏好未实现。', '[身份](../../apps/web/src/identity.tsx) / [空间](../../apps/web/src/team.tsx)'),
'03-06': ('成员/项目权限/会话撤销与事件更新已有，访问撤销后清除页面旧数据；最后管理者有保护。项目归档和已运行远程进程的撤销联动未实现。', '[成员](../../packages/db/src/collaboration.ts) / [事件](../../apps/control/src/app.ts)'),
'04-01': ('Task 修订、创建者归属和真实个人/项目访问范围已有；改派、参与者及正式存储的完整模型尚缺。', '[任务](../../packages/db/src/store.ts)'),
'04-02': ('完成/重开/取消及活动执行后端联动已有，团队编辑权限已校验；完整动作 UI 与远程执行联动仍待收口。', '[任务](../../packages/db/src/store.ts) / [页面](../../apps/web/src/App.tsx)'),
'04-06': ('真实项目/个人 Task 共用 DTO、创建和权限；跨空间选择性转移与完整归属切换未完成。', '[任务](../../packages/db/src/store.ts)'),
'07-03': ('本机事件、游标和 SSE 已接真实会话/空间/项目权限，会话与成员撤销会断流；独立节点远程事件通道未完成。', '[事件](../../apps/control/src/app.ts)'),
'10-01': ('TaskDetail 双状态布局已接真实成员访问范围，只读成员禁用编辑；高级布局/共享范围功能仍待完善。', '[任务页面](../../apps/web/src/App.tsx)'),
'15-01': ('工作台和项目聚合按真实主体/空间/项目权限过滤；完整团队汇总与协助/接手查询仍缺。', '[工作台](../../packages/db/src/store.ts)'),
'15-04': ('任务中文关键词搜索按真实会话/项目和私有任务权限过滤；跨资料、成果等实体搜索未完成。', '[查询](../../apps/control/src/app.ts)'),
}
p=Path('docs/development/19-work-items.md'); s=p.read_text()
for key,(detail,proof) in updates.items():
    pattern=rf'^(\| HX-DEV-{key} \| [^|]+ \| [^|]+ \| )[^|]+ \| [^|]+ \| [^|]+ \|$'
    s,n=re.subn(pattern,lambda m:m[1]+'部分实现 | '+detail+' | '+proof+' |',s,flags=re.M)
    assert n==1,key
s=s.replace('逐项核对，E1c。','逐项核对，E2a。').replace('部分实现 55 项、未实现 45 项','部分实现 59 项、未实现 41 项').replace('E0/E1a/E1b/E1c 是','E0/E1a/E1b/E1c/E2a 是')
old='本轮推进 **11-01、11-02、11-05** 的持久化接续切片，并补及 01-04、07-02、07-06、10 的相关部分。**不是执行完前十包，也没有进入 11-03 的真实协助。**'
assert old in s
s=s.replace(old,'本轮推进 **03-01—06** 的真实账号、空间、项目权限与撤销切片，并同步相关 UI、任务查询和 SSE。**本机团队模式没有执行器，不能把登录上线等同于完成远程团队产品；11-03 临时协助尚未开始。**')
s=s.replace('E0—E1c 已建立本机页面、双工具和持久化接续切片；下一组补身份、正式存储与独立执行器，不能将临时协助提前伪装为多人协作。','E0—E1c 的本机工具预览保留；E2a 新增独立的真实账号与协作数据模式。下一组补独立执行器与正式存储，不让团队账号继承宿主机执行权限。')
s+='\nE2a 推进真实账号、个人/团队空间、邀请、项目角色与访问撤销。03-01/02/05/06 从未实现调整为部分实现；保留原工作项完整范围和未完成内容。\n'
rows=[l.split('|')[4].strip() for l in s.splitlines() if l.startswith('| HX-DEV-')]
assert len(rows)==102 and Counter(rows)=={'已完成':2,'部分实现':59,'未实现':41}
p.write_text(s)

Path('docs/development/21-implementation-status.md').write_text('''# 21｜当前实现进度

更新：2026-09-26（UTC+8）。阶段：**E2a 本机真实账号、空间与项目权限**。产品 v1.1 / D1 完整目标不变。

## 本轮任务与实际能力

推进 `HX-DEV-03-01—06` 的本机纵向切片，关联 `01-01/04、02-02、04、07-03、10、15`。原清单现为 **2 项已完成、59 项部分实现、41 项未实现**，不代表完成百分比；第 03 包仍未整包完成。

| 能力 | 本轮实现 |
| --- | --- |
| 账号与会话 | Better Auth 1.7.6 实际密码认证、HttpOnly Cookie、初始化、登录/退出、改密、会话重启恢复与撤销；不是切换虚构身份 |
| 空间与邀请 | 每人独立个人空间；可建团队；绑定受邀邮箱的随机邀请、哈希保存、过期、撤销和单次接受 |
| 项目权限 | 显式 view/edit/manage 项目成员；空间管理员不会自动获得其他项目或私人任务权限 |
| 共享工作 | 多账号在获准项目内创建/讨论任务、发布文字成果、反馈和标记完成，记录真实账号名字 |
| 服务端访问控制 | 列表、搜索、直接 ID、成果、Run/Operation 父任务和 SSE 共用权限；并发请求身份隔离，权限检查先于幂等重放 |
| 撤销与恢复 | 移除成员、撤销项目访问、会话失效后断开事件并清理旧界面数据；最后管理者有保护 |
| UI | 登录/邀请页面、个人/团队切换、空间成员管理、项目权限卡、浅深色与窄屏布局 |

## 两种模式不能混报

**默认 preview** 保留原有示例身份、本机 Claude/Codex 与 E1c 持久化接续，仍不是多用户服务。

**可选 team-local** 使用真实账号和独立数据文件，但仍只允许回环地址。它拒绝原生工具配置、宿主机目录浏览、模拟/原生执行派发和接续启动。独立 Runner、节点身份及项目执行授权未完成前，任何团队账号都不能继承这台电脑的目录或模型账户。

旧 `.hexu/preview.sqlite` 不会被清空、重命名或自动导入团队。把预览数据直接当成团队业务库会拒绝启动。正式 PostgreSQL 与可选择的旧数据导入仍未实现。

## 明确保留的未完成项

有效账户下真实模型生成仍未联调；原生 resume/运行中输入、临时协助、跨成员代码接手、并行分支、独立 Runner、PostgreSQL、通用远程预览和正式远程部署未完成。

账号邮箱尚未邮件验证，邀请由操作者手动转交，不声称已发送邮件；忘记密码恢复、SSO、所有者转移、完整空间角色管理、项目编辑/归档和仓库引用仍待开发。该版本不是经生产审计的身份系统或公网团队服务。

## 工程结果

本地 Linux / Node 24.21.0：格式、双端 TypeScript、**92 条工程测试**和前后端构建已通过。新增真实密码/会话、邀请、跨账号隔离、只读限制、幂等授权、并发请求、SSE 撤销和旧数据库保护测试，使用虚构账号但实际认证组件，不是认证协议替身。

本地 Chromium 被环境策略阻止访问 localhost（ERR_BLOCKED_BY_ADMINISTRATOR），不计为本地浏览器通过。新增 3 条真实账号浏览器流程，最终浏览器结果待具体 GitHub Actions 记录登记，不能由测试定义推断通过。

上一轮 E1c 主分支为 `194fee9`，保留其 70 条工程测试和 17 条 Chromium 流程。此次原生工具回归继续使用明确的协议替身，没有调用真实模型。临时源码传输和写入式开发工作流不进入主分支，主分支保持只读 CI。

## 后续

本机多人数据协作已接入，但不开放远程地址来伪装完成团队运行。下一步优先独立 Runner 配对/节点身份、受管目录与项目派发权限，并对齐正式存储迁移；范围见 [22](22-next-delivery.md)。使用方法见 [本机账号模式](../engineering/team-local.md)。
''')

Path('docs/development/22-next-delivery.md').write_text('''# 22｜下一步交付：把成员电脑与控制服务分开

更新：2026-09-26（UTC+8）。E2a 已实现本机真实账号、空间、项目权限和数据协作切片；第 03 包完整范围仍保留在任务清单。

## 为什么下一步是独立 Runner

登录解决了“谁能看与改共享数据”，尚未解决“谁能让哪台电脑使用哪个目录和模型账户”。不能把当前服务改成 0.0.0.0，就称为团队执行。当前 team-local 因而拒绝全部宿主机执行派发，preview 的原生能力单独保留。

下一批 E2b 先推进 `06-01` Runner CLI/配对/节点身份和 `06-02` 主动连接/心跳，联动 `06-03/04` 的目录授权与 `07-02/03/06` 的派发、ACK、事件和停止。每个节点由本机操作者显式配对，授权工作区与项目范围可撤销；控制服务不接收节点的 API key，不把空间管理员当作节点拥有者。

首个可用切片是：登录后看到自己配对的节点与授权目录；给获准项目派发一项执行；看到真实状态与输出；重复派发不重复启动；失联如实显示未知，不假装停止。网络 ACK、持久化 spool、启动关联与恢复必须一起处理，不能仅靠轮询打印“在线”。

## 正式存储与账号能力的并行补齐

`01-04` PostgreSQL 适配与迁移应保留原 Task/Run/Result/Operation ID，不复制领域模型。认证库和业务库的恢复顺序、旧 SQLite 数据导入以及原生历史中的路径/敏感上下文共享范围需要明确。E2a 没有将虚构示例成员自动映射成真实账号。

03 包还需邮件验证/找回密码、所有者转移、完整成员角色、项目编辑归档与仓库引用。先按实际需要补齐，不引入组织架构、绩效评价或强制验收中心。

## 协助和接手何时进入

`11-03/04` 需要选择性快照、有限 AccessGrant 与只读或隔离协助环境；只有项目登录权限并不满足这一边界。`12` 接手需要不可变检查点和目标恢复；当前有界 Git 摘录不是完整代码检查点。并行代码分支也不能共用活动写入目录。

真实模型联调仍单列未完成；在授权的非敏感仓库和有效账户下才测试，不将 Key 写入仓库、任务或公共 CI。UI 随纵向功能交付，公司的质量/效果评估仍在产品外进行。
''')

Path('docs/engineering/team-local.md').write_text('''# E2a｜本机真实账号与空间

2026-09-26（UTC+8）。这是同一台机器上可使用不同浏览器会话的真实账号开发模式，**不是跨电脑或公网团队部署**。代码执行仍等待独立 Runner。

## 启动

Node 24，先 `npm ci`。在本机未跟踪的 `.env` 中配置：

```dotenv
HEXU_MODE=team-local
HEXU_NATIVE_ENABLED=0
```

执行 `npm run dev`，打开 `http://127.0.0.1:5173`；或 `npm run build` 后 `npm start`，打开 `http://127.0.0.1:4310`。开发模式两个端口只允许既定来源，不扩展为跨站服务。

未设置 HEXU_DATA_DIR 时，此模式数据在 `.hexu/team`。若已有 `.env` 设置了 HEXU_DATA_DIR，则使用该显式目录。文件包括 `workspace.sqlite`、`identity.sqlite`、随机 `auth-secret` 和 `setup-code`。代码/密钥文件以本机受限权限写入，不把值打印到日志。环境中的 HEXU_AUTH_SECRET / HEXU_SETUP_CODE 可显式覆盖，须至少 32 个字符，不能使用团队共享默认密码。

首次打开页面，由本机操作者读取数据目录中的 `setup-code`，在建立账号页面输入。初始化只允许首个账号消费；随后使用各自密码登录。不要把初始化代码、认证 secret 或数据库上传仓库、截图或聊天。

## 真实协作流程

账号建立后默认进入个人空间。到“空间与账号”创建团队，生成绑定邮箱的邀请链接，通过可信渠道手动转交。系统没有邮件发送服务，邮箱地址尚未邮件验证；邀请的持有与接收必须由团队自行确认。

邀请 48 小时有效，数据库只保存 token 哈希。完整链接仅生成时显示；同键重放不会重新暴露 token，可撤销再生成。链接使用 URL fragment，服务端在明确的 POST 中接收，不把 token 放进请求查询日志。不要把它发到公开渠道。

加入团队不等于可查看所有项目。项目创建者在权限卡添加成员并选择“只读 / 可编辑 / 管理”。空间管理员不会自动读取成员个人任务。最后项目管理者不能被直接移除；先指定另一个管理者。空间所有者转移暂未提供，所有者不能直接退出造成无管理者状态。

可在同一机器的不同浏览器资料或隔离上下文中体验两个真实账号，创建任务、讨论、发布文字成果和完成任务。执行按钮明确不可用；这一模式不会探测或调用宿主机 Claude/Codex、读取本地 Git 根或使用其 API key。

## 会话、撤销与已知限制

登录使用实际密码哈希和 HttpOnly Cookie；页面存储只保存界面偏好、当前空间 ID，不保存长期登录令牌。改密要求当前密码并撤销其他会话；可退出或撤销全部登录。忘记密码恢复和 SSO 尚未实现，不提供伪装可用的重置入口。

移除项目权限后，直接链接/搜索/列表和后续事件都重新校验，打开的旧任务内容会清除。移除空间成员后返回个人空间。会话过期或撤销后关闭流并显示登录页。已经显示或人为另存的数据不能被撤销追回。

服务重启保留账号、会话和业务记录。认证与业务为独立 SQLite 文件，注册与邀请接受不是跨库单事务：接受前再次核验邀请；邀请在密码计算期间被撤销时，可能保留一个账号及个人空间，但不会获得已撤销的团队成员权限。遇到初始化进程中断而无账号的特殊状态，需要本机操作者核查，不自动开放第二次初始化。

默认 preview 继续使用 `.hexu/preview.sqlite` 与示例身份；team-local 另用 workspace.sqlite，不清空旧数据。将预览业务库直接传给 team-local 会拒绝启动。旧数据导入、生产备份恢复、PostgreSQL 和跨节点迁移未完成。

本机 HTTP Cookie 不以 Secure 标记冒充 HTTPS。回环访问、来源校验和认证组件不是操作系统隔离，也不能防止本机文件系统操作者读取数据库。不要用反向代理、隧道或 0.0.0.0 暴露此版本。正式 TLS、外部邮件、远程部署和独立节点授权必须另行交付。
''')

Path('docs/engineering/adr-0005-local-identities.md').write_text('''# ADR-0005｜真实账号与本机执行分离

日期：2026-09-26（UTC+8）。对应 HX-DEV-03 与 01-04 的本机切片。

## 决策

选择锁定 Better Auth 1.7.6，经 IdentityPort 处理密码、Cookie 会话和撤销；使用该版本支持的 node:sqlite 与程序化迁移。HEXU 不另造 JWT 签名或密码哈希方案。不直接挂载全量认证路由，仅开放明确的登录/退出/初始化/受邀加入/改密/撤销入口；注册还在组件钩子中检查受控上下文。

业务权限属于 HEXU：空间成员与项目 view/edit/manage 分离，私有任务仅所有者可读。PermissionService 同时用于查询与写入；请求主体通过 AsyncLocalStorage 绑定而不是修改全局 actor。已撤权用户不能通过旧幂等响应读取结果；SSE 每次发送前重查会话和授权。

认证文件和团队业务文件独立于旧预览数据。团队模式没有默认示例用户，也不会把“林舟”等虚构记录自动授予第一个注册者。预览模式仍可独立运行已有本机 Agent；真实账号模式禁止继承宿主机能力，等待独立节点授权。

## 限制

当前只支持回环地址、单服务进程与 SQLite。没有 SMTP 验证、忘记密码恢复、SSO、通用 AccessGrant、PostgreSQL 或生产安全审计。跨认证/业务库注册失败不做不可靠的跨库回滚；再次核验邀请以防未授权加入，保留明确恢复路径。

## 采用时核对的上游资料

- Better Auth SQLite： https://www.better-auth.com/docs/adapters/sqlite
- Email / Password： https://www.better-auth.com/docs/authentication/email-password
- Fastify 集成： https://www.better-auth.com/docs/integrations/fastify
- 会话： https://www.better-auth.com/docs/concepts/session-management
- 安全与 Cookie： https://www.better-auth.com/docs/reference/security

接口使用锁定发行包的类型和实际用例核对，不以网页说明替代运行结果。依赖版本不是长期兼容或无漏洞承诺。
''')

p=Path('README.md');s=p.read_text();start=s.index('> **当前阶段：');end=s.index('\n\n## 启动',start)
s=s[:start]+'''> **当前阶段：E2a 本机真实账号、空间与项目权限。** 默认 `preview` 保留示例工作台、实验性 Claude/Codex 和持久化接续；可选 `team-local` 新增实际密码账号、邀请、项目成员权限和多人数据协作。**两种模式隔离，团队账号不能使用宿主机目录或模型密钥。** 当前仍仅限本机，不是可公网部署的团队服务；独立 Runner、PostgreSQL、远程执行及有效账户下真实模型生成联调仍未完成。'''+s[end:]
where='## 当前能操作什么'
s=s.replace(where,'''## 可选：真实账号与空间

在本机 `.env` 设置 `HEXU_MODE=team-local`、`HEXU_NATIVE_ENABLED=0` 后启动。未指定数据目录时使用 `.hexu/team`，首次初始化代码在该目录的 `setup-code` 文件；已有 HEXU_DATA_DIR 设置优先。账号建立后可以创建团队、手动转交邀请，并在项目中配置只读/编辑/管理成员。

旧 preview 数据不自动公开或导入。team-local 暂不提供任何模拟/原生执行，等待独立节点及执行授权；两个浏览器会话能协作数据，不代表已支持两台电脑。详见 [本机账号模式](docs/engineering/team-local.md)。

'''+where)
s=s.replace('| 多成员登录、临时协助、并行分支、独立 Runner 和远程执行 | 尚未实现 |','| 实际账号、空间、邀请、项目角色、会话/权限撤销 | team-local 本机模式已实现；邮件验证、找回密码、正式部署等仍缺 |\n| 临时协助、并行分支、独立 Runner 和远程执行 | 尚未实现 |')
s=s.replace('## 可选：启用本机原生工具','## 可选：preview 模式启用本机原生工具')
s=s.replace('数据保存在 `.hexu/preview.sqlite`，','默认 preview 数据保存在 `.hexu/preview.sqlite`，')
s=s.replace('SQLite 是让本地预览无需额外数据库的阶段性选择','SQLite 用于本地预览和本机账号模式，是阶段性选择')
s=s.replace('推荐 Node.js 24。','使用 Node.js 24（team-local 需要 node:sqlite 支持）。')
p.write_text(s)
append('docs/development/03-identity-projects.md','''\n## E2a 实现记录\n\n03-01—06 已交付本机账号/空间/项目权限切片，全部仍标部分实现。实现采用 Better Auth 1.7.6、PermissionService 与真实角色 UI，不再仅固定示例身份。未接邮件验证/找回密码、SSO、所有者转移、项目归档和仓库引用；原生执行仍需独立 Runner。具体边界见 [21](21-implementation-status.md)，使用见 [本机账号模式](../engineering/team-local.md)。\n''')
append('docs/development/18-data-api-catalog.md','''\n## E2a 实现子集：真实账号与访问范围\n\n只在 team-local 启用，仍为回环服务。`GET /identity` 返回模式、初始化状态、当前用户和空间；POST `/identity/setup`、`sign-in`、`sign-out`、`change-password`、`revoke-sessions`、`invitation-preview`、`join` 是明确允许的认证入口。原始 `/api/auth` 不开放，不返回页面可读取的 session token。\n\n业务请求用 HttpOnly Cookie 认证及 `X-Hexu-Space` 选择当前已加入的空间；SSE 以 spaceId 参数选择但仍由 Cookie 校验成员关系。写入要求来源、客户端标识和现有业务幂等键。POST `/spaces` 建团队；GET/POST `/spaces/:spaceId/invitations`、POST `.../:invitationId/revoke`；GET `/spaces/:spaceId/members`、POST `.../:userId/remove`；GET `/projects/:projectId/members`、POST `.../:userId` 配置 view/edit/manage 或 null 移除。完整输入以 contracts/identity 和 control/identity 代码为准。\n\n直接 Task/Run/Result/Operation、列表、搜索与事件受同一权限约束。既有普通任务、讨论、文字成果和完成接口在团队空间可用。原生资源、上下文预览、全部 Run/接续派发在团队模式返回 RUNNER_REQUIRED，不以登录赋予本机文件或模型权限。正式节点、附件 AccessGrant 与跨空间发布仍未实现。\n''')
append('AGENTS.md','''\n## E2a identity boundary\n\nThe default preview remains single-user and fictional. Optional team-local uses Better Auth 1.7.6, real users and explicit project roles, but stays loopback-only. It never initializes host native resources or accepts mock/native execution dispatch. Independent node identity and grants must land before team execution. Preserve separate preview/business/auth databases; do not relabel or seed preview data as team data.\n\nUse request-scoped principals and PermissionService for direct objects, lists, search, SSE and idempotent replays. Space ownership is not access to another person's private task or every project. Check permissions before returning stored idempotent results. Revalidate session and membership during event delivery; clear old UI data on revocation or identity changes. Keep session tokens out of browser storage/JSON, secrets out of logs, and invitation tokens hash-only at rest. Do not expose the full authentication handler or unrestricted signup. Email verification, password recovery and production/remote security remain incomplete; see team-local.md.\n''')
p=Path('docs/engineering/dependencies.md');s=p.read_text().replace('# E0 依赖清单','# E2a 依赖清单').replace('| Fastify | 本地 API 与网页服务 | MIT |','| Fastify | 本地 API 与网页服务 | MIT |\n| Better Auth 1.7.6 | 实际密码认证、Cookie 会话及撤销 | MIT |');p.write_text(s)
p=Path('.env.example');s=p.read_text().replace('HEXU_DATA_DIR=.hexu','# HEXU_DATA_DIR=.hexu  # Optional override; defaults: preview=.hexu, team-local=.hexu/team').replace('# Optional E1b native file-tool execution.','# Optional preview-only native file-tool execution.');s+='\n# Optional real local accounts. Still loopback-only; no host execution or remote service.\nHEXU_MODE=preview\n# Set team-local to enable accounts. Keep HEXU_NATIVE_ENABLED=0 in that mode.\n# First setup uses data-directory/setup-code; auth-secret is generated and retained locally.\n# Do not commit database files, setup codes, auth secrets or passwords.\n';p.write_text(s)
marker.write_text('E2a actual scope and remaining tasks documented.\n')
