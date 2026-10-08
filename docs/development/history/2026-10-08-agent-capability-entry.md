# Agent 身份与有限能力入口候选记录

2026-10-08。本记录随当前候选准备，新增有限身份/能力子集已有定向与静态检查，原server编译与完整应用API集成已补验，仍缺真实浏览器验收，不代表切片1完整验收或跨Agent自主协作完成。

## 来源与验证归属

- 代码基线为普通候选 `e0e2145c19782cf00b50b97cc22c4c7ea79482ef`。
- 规划文档来自 `5fe1d8bd5cb6e1c5e3e2790da5474a5f7cfc185c`，共同基线为 `c73be08be9a645e95c5f9d3ac7e0822e812bcb0b`。19/22 按三方事实合并；规划不提高任何原工作项状态。本轮复核远端 main/规划/普通候选 heads 仍分别为上述固定来源；197 份普通候选基线文件的 hash 与 e0 等价。
- 普通候选既有 55+19 定向、React/Store 桥接和完整原 Web 类型/Vite 通过记录仅属于原候选；不能挪作新身份/能力代码的检查结果。普通候选原有记录不含整套server/浏览器/full CI通过；本候选随后补齐原server编译与完整应用API集成，具体见后文补验。
- 主线 browser run `37719679187` 失败原因尚未定位，旧 PR77 绿色不能作为本候选最终 CI。没有开展受限诊断。
- 旧原任务反馈实现与定向验证已本地保全，提交 `3cadee3` 未挂分支、未交付，本轮未引用。

## 切片 1 前置技术探测

本轮在隔离云开发环境执行了有限版本探测：Node `v24.19.0`；`command -v claude` 无输出，表示 PATH 未找到 Claude 命令；Codex 路径 `/opt/codex/bin/codex`，`codex --version` 输出 `codex-cli 0.159.2`，同时给出只读文件系统导致不能创建 PATH aliases 的 warning，退出码为 0。

仅该版本命令不调用模型。本轮没有读取会话、配置或凭据；没有验证云内置 Codex 能作为用户 HEXU 的实际客户端。上述路径只是本次开发机观测，不是产品安装前提或受支持平台保证。

当前已按用户选择固定首条路线：本机 Codex + 当前 dot，双方均通过 HEXU 发现、读取、澄清与回传，不走直接旁路。先前“乙为待选独立自建轮询Agent”仅是旧候选，已被此选择替代。首轮是同一真实用户的两个独立Agent跨环境；仍需要第二个真实成员才能验证产品原定跨成员里程碑。

官方文档已核实可研究的技术路径：HEXU 提供受认证的 [MCP工具入口](https://developers.openai.com/plugins/build/mcp-server)；dot侧使用 [MCP Events](https://developers.openai.com/plugins/build/mcp-events)（MCP 2.0，协议版本2026-07-28）的events/list、subscribe、unsubscribe。用户授权订阅后，HEXU向该订阅提供的callback投递签名事件，dot再通过HEXU工具读取及回应。该路径是拟实现的接收方案，不是当前产品已有自动收件。

Codex侧拟使用MCP工具和持久线程关联；[app-server](https://learn.chatgpt.com/docs/app-server)提供thread/resume与turn/start，[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)提供resumeThread及同线程run。实际采用哪一条继续接口应结合用户本机已安装版本验证，不能以开发机CLI版本代替。

当前没有已接通的HEXU插件、MCP事件订阅或本机访问，尚未完成callback/签名/授权的实际往返。用户选择路线不等于授权生成或配置持续访问凭据；真实持久权限配置仍须另行授权。用户本机Codex版本、实际账户、费用主体与部署条件尚未测量或确认。开发执行器与协议替身不代表用户真实双Agent验收；本轮真实身份集成使用内存假账号，不激活用户账号或模型。切片7仍未验证。

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
- 初轮未运行完整control/全server编译，随后已按下文补验通过；真实浏览器、原99个测试、原生构建helper、整仓构建或full CI仍未运行；未调用真实账户/模型或付费外部服务，未测试正式远端部署。

旧15文件本轮SHA256重验与保全内容相同，旧反馈代码没有并入本候选。普通候选及规划原有证据分别保留，新检查只覆盖本节明确范围。

## 状态与下一项

19中16-04、16-06因实际有限身份/能力/连接与界面子集由未实现变部分实现；其余原状态保持，当前102项为3完成/82部分/17未实现。没有整项新增完成。

唯一下一项仍是切片1已有入口的真实浏览器界面补验与选定客户端前置条件核对；原server完整编译与完整应用API身份链已通过，不重复列为全部未运行。达到本片验收边界后再切到切片2。切片2可整理固定材料/请求/协商设计依赖，不能称作第二个并行下一项。MCP/A2A桥、真实接收、双向协商、结果消费、双独立Agent/跨环境闭环属于后片，均未借此宣布完成。


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


## 原server与真实身份完整应用API补验

本次补验仅增加验证文件，没有修改生产代码。恢复原server静态依赖闭包后，260份原server TypeScript文件与固定候选blob逐份相等，原tsconfig.server.json及include/exclude未改。`node_modules/.bin/tsc -p tsconfig.server.json`原配置编译退出0；程序来源核对为257根文件、276仓库输入、803外部声明。此处是完整原server静态编译，不是把定向编译扩大表述；没有运行原99个测试或原生构建helper。

新增[完整应用API集成](../../../verification/agent-real-app.test.mjs)通过8/8（7子检查+1父检查）：真实createApp、原Better Auth、Store及完整路由注册，无fakePrincipal、Store或route替身。使用内存假账号完成setup/invite双用户、真实签名Cookie、原request-scoped身份hook及host/origin/client核验，覆盖两所有者隔离、连接token互斥/降权及signout。父/子计数按测试运行器输出保留，不视作8个独立业务场景。

另[真实身份基础检查](../../../verification/agent-real-identity.test.mjs)1/1通过，使用真实Better Auth内存session。两组没有监听端口、真实浏览器、真实用户账户、模型或外部服务调用；它们补齐此前显式Principal夹具没有覆盖的身份与完整应用API路径，但不证明端到端网络/浏览器验收。原18后端、15React、4真业务桥接分别保留其自身边界，不相加包装为完整CI。

当前102项仍为3完成/82部分/17未实现，不提前宣布切片1完整验收。

使用原锁文件依赖的复现命令（仓库根）：

```sh
node_modules/.bin/tsc -p tsconfig.server.json
node --test verification/agent-real-identity.test.mjs
node --test verification/agent-real-app.test.mjs
```

两个验证文件默认读取原编译输出 `dist`；需要指定另一份相同编译输出时可用 `HEXU_SERVER_DIST`。没有执行 `npm run test`、`check` 或原生构建脚本，也不更改原配置的测试排除范围。独立只读补审确认测试直接使用原注册/认证链，未发现新的实质阻断；该审阅本身没有运行测试。
