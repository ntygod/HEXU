# Agent 身份与有限能力入口候选记录

2026-10-08。本记录随当前候选准备，新增有限身份/能力子集已有定向与静态检查，仍缺完整运行/浏览器验收，不代表切片1完整验收或跨Agent自主协作完成。

## 来源与验证归属

- 代码基线为普通候选 `e0e2145c19782cf00b50b97cc22c4c7ea79482ef`。
- 规划文档来自 `5fe1d8bd5cb6e1c5e3e2790da5474a5f7cfc185c`，共同基线为 `c73be08be9a645e95c5f9d3ac7e0822e812bcb0b`。19/22 按三方事实合并；规划不提高任何原工作项状态。本轮复核远端 main/规划/普通候选 heads 仍分别为上述固定来源；197 份普通候选基线文件的 hash 与 e0 等价。
- 普通候选既有 55+19 定向、React/Store 桥接和完整原 Web 类型/Vite 通过记录仅属于原候选；不能挪作新身份/能力代码的检查结果。整套 server、浏览器与 full CI 没有本轮通过结论。
- 主线 browser run `37719679187` 失败原因尚未定位，旧 PR77 绿色不能作为本候选最终 CI。没有开展受限诊断。
- 旧原任务反馈实现与定向验证已本地保全，提交 `3cadee3` 未挂分支、未交付，本轮未引用。

## 切片 1 前置技术探测

本轮在隔离云开发环境执行了有限版本探测：Node `v24.19.0`；`command -v claude` 无输出，表示 PATH 未找到 Claude 命令；Codex 路径 `/opt/codex/bin/codex`，`codex --version` 输出 `codex-cli 0.159.2`，同时给出只读文件系统导致不能创建 PATH aliases 的 warning，退出码为 0。

仅该版本命令不调用模型。本轮没有读取会话、配置或凭据；没有验证云内置 Codex 能作为用户 HEXU 的实际客户端。上述路径只是本次开发机观测，不是产品安装前提或受支持平台保证。

首条路线仍是设计候选：甲使用 Codex 的 HEXU MCP 工具入口；乙使用独立自建 `text-expertise` 轮询接收 Agent。乙的具体实现、版本和服务尚未选定，接收/查询/继续方式尚未实际互操作。甲的版本只有上述开发机探测，并非用户端已确认版本。

双方真实账户、独立运行环境、费用主体和真实远端均未确认或获授权。开发执行器与协议替身不代表用户的真实双 Agent 验收。缺少这些条件不阻止编写有限契约与入口，但切片 7 的真实异构闭环继续未验证。

## 实际代码子集

- 契约/领域：`packages/contracts/src/agent-capabilities.ts` 与 `packages/domain/src/agent-capabilities.ts`，保持参与身份、端点、能力和AgentProfile分别管理。
- 事务/迁移：`packages/db/src/agent-capabilities.ts`、schema迁移36；有限预授权、不可变能力版本、连接摘要、当前权限/固定修订/回执与outbox。所有者、端点、项目/空间撤权与归档使旧授权/连接永久失效，恢复不复活。
- HTTP/身份：`apps/control/src/agent-capabilities.ts`、`apps/control/src/agent-connections.ts`、`packages/identity/src/agent-connections.ts`；独立凭据只有GET身份与单项目能力读取，不能申请/执行或读取材料。只读连接最长24小时，固定身份/connection ID轮换、一次响应token，重试旧键返回null，不在回执/日志保存明文。
- Client/UI：`packages/client/src/agent-capabilities.ts`、本人资源管理、项目目录与状态恢复组件。资源路由之间保留未知请求原包/原键；凭据创建/轮换/撤销显式进行，不替真实账户激活。端点地址只作为元数据保存，无HTTP探测。
- 能力三维仍如实区分：提供方unverified、接收适配not_integrated、授权/环境条件单列，callable=false；request/autoAccept是有限预授权意向，并非已发请求或执行。

## 本地检查与限制

本轮实际检查结果：

- 后端18项通过，按原server全部flags定向编译通过（并非整个server工程类型检查）：真实SQLite、PermissionService、Fastify.inject，覆盖多所有者、多Agent、有限可发现/请求授权、旧键/撤权、摘要凭据轮换/撤销、归档后恢复不复活，以及真实文件数据库关闭重开和故障回滚。显式Principal隔离夹具，不是Better Auth或完整control服务器启动。
- UI15项通过：实际UI/client/hooks，useApp/Button/fetch/FormData替身，React/react-test-renderer 19.2.0、esbuild 0.25.10；不是DOM、焦点、浏览器或真实输入法验收。
- 真业务桥接4项通过：实际UI→共享client→Fastify.inject→schema36/SQLite→PermissionService/新Store，业务响应没有替身。仅App身份/request Principal、Button/FormData为夹具，fetch只是无listener注入运输；覆盖登记/端点/能力/预授权到另一假成员目录选择、提交后丢响应跨路由同key去重、真实SQL降权清理原包/隐藏目录与归档清选择。不等于Browser、Better Auth、真实账号或真实网络验收。
- 原`node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit`退出0，使用完整原配置、无本地类型stub，来源核对包含98根文件、140仓库输入、70外部声明/标准库及729个import；原`vite build --config apps/web/vite.config.ts`通过172模块，JS 715.29 kB、gzip 202.96 kB，有非阻断大于500 kB bundle提示；原check-ui-tokens通过。
- 独立审阅先指出未知请求离开路由后丢失、归档恢复复活旧授权两个问题，已修正并增加回归；最终只读复核与桥接/文档补审均未发现未修复的实质阻断。审阅没有运行测试，不把发现问题前的结果挪作最终代码验收。
- 未运行真实浏览器、完整control/全server类型检查、整仓构建或full CI；未调用真实账户/模型或付费外部服务，未测试正式远端部署。

旧15文件本轮SHA256重验与保全内容相同，旧反馈代码没有并入本候选。普通候选及规划原有证据分别保留，新检查只覆盖本节明确范围。

## 状态与下一项

19中16-04、16-06因实际有限身份/能力/连接与界面子集由未实现变部分实现；其余原状态保持，当前102项为3完成/82部分/17未实现。没有整项新增完成。

唯一下一项仍是切片1已有入口的运行与界面补验；达到本片验收边界后再切到切片2。切片2可整理固定材料/请求/协商设计依赖，不能称作第二个并行下一项。MCP/A2A桥、真实接收、双向协商、结果消费、双独立Agent/跨环境闭环属于后片，均未借此宣布完成。


## 迁移兼容与策略边界

原schema迁移1—35字节完整保留，既有前缀SHA256为 `140c189a5adedd9b0d3d965828b3603b23031f7293f0267b80217d8d86b1da4b`；本轮只追加迁移36。日期原迁移35及普通候选字段没有被重新编号。

并发1—4、费用主体与autoAccept只保存有限预授权策略，尚无实际执行器进行并发强制或费用联调。端点 `authentication: not_integrated` 指出站接收适配未接入；入站短期capability_read连接独立存在，不证明端点可调用。

## 复现React定向检查

需Node24与npm；在仓库根准备临时测试工具，使用官方npm registry及禁用安装脚本，不更改仓库锁文件。以下是给后续操作者的复现命令，并非本次额外执行记录：

```sh
tools_dir="$(mktemp -d)"
printf '{"private":true,"type":"module"}\n' > "$tools_dir/package.json"
npm install --prefix "$tools_dir" --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund react@19.2.0 react-test-renderer@19.2.0 esbuild@0.25.10
HEXU_UI_TEST_TOOLS="$tools_dir/package.json" node --test verification/agent-capabilities-ui.test.mjs
HEXU_UI_TEST_TOOLS="$tools_dir/package.json" node --test verification/agent-capabilities-bridge.test.mjs
```

`HEXU_UI_TEST_TOOLS` 是工具包package.json的绝对路径；不要依赖测试脚本内开发机临时目录的回退值。15项React检查与4项真业务桥接分别记录，不合并成完整CI数量；桥接还需按仓库原锁文件安装已有Fastify等依赖。两者均不取代真实浏览器。
