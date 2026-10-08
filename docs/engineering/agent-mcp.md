# 有限 Agent 的本地 MCP 入口

这是切片3的本地薄协议入口，服务端仍由原 HEXU Assistance/权限/回执管理。它不启动模型，不接管原生线程，也不提供远程 MCP 或 dot Events。实际检查及未验证范围见[交付记录](../development/history/2026-10-08-agent-mcp-entry.md)。

## 所有者预授权与引导

1. 在真实账号的 team-local 中登记本人发起 Agent 与接收 Agent。两者有各自端点元数据；同一所有者可有两个 Agent，但不能据此宣称跨成员验收。
2. 在原 Task 协助入口选目标、本人发起身份、固定消息摘录/项目纯文本，预览后明确签发有限发起凭据。它固定一个 Task、一个目标能力/授权版本、已有选材范围和最长24小时期限。它允许在该范围内改问题、补充澄清及删减材料；不能读取整个父 Task、追加其他资料、运行模型或写文件。
3. 明文只在首次响应显示一次；丢失后核对已发行记录并撤销，再明确发行新凭据。凭据不写浏览器存储，也不放源码、命令参数、日志或截图；使用所有者自己的受控进程环境传入。
4. 接收端仍需所有者为**一个已创建请求**发行原 `material_read` 或 `material_read+respond` 凭据，并提供该 requestId。它仅能取这一个请求，不能列出整个项目或替另一 Agent 收件。此步骤目前需人工配置；**没有初始登记后自动收到新请求的 bootstrap/投递**。测试预置该合法凭据后，多轮澄清/补充/回答不再换 token 或搬运中间问答。

新项目文本使用稳定opaque material ID，同源在选材排序、不同有限凭据及Web/MCP补充之间不重编号。早期顺序型text-N输入仍保留原快照、供原真人/接收入口使用；新发起凭据不会自动接管别名不一致的旧请求，避免选错材料。

旧 `capability_read` 连接、浏览器 Cookie 和节点凭据均不能代替新的发起凭据；接收请求 token 也没有发起权限。到期、撤销、端点/能力/目标授权变化或当前成员/项目条件失效时停止访问，重新加入不复活旧代。固定材料源变化后要求重新确认授权；桥不会偷偷扩大选材。

## 启动与配置

使用 Node24，先按原工程命令编译 `npm run build:server`。可执行入口为 `node /absolute/HEXU/dist/apps/mcp/src/main.js`，仓库静默脚本为 `npm run --silent mcp`（普通npm启动横幅会污染stdio）。stdout 专用于一行一个 JSON-RPC 消息；诊断仅向 stderr 输出不含材料/凭据的固定文案。

| 环境变量 | 含义 |
| --- | --- |
| `HEXU_CONTROL_URL` | 默认 `http://127.0.0.1:4310`；只接受显式 `127.0.0.1` 或 `[::1]` HTTP origin，不含路径/账号/query/hash |
| `HEXU_AGENT_ROLE` | `requester` 或 `receiver` |
| `HEXU_AGENT_TOKEN` | 对应角色的独立有限凭据，必须由所有者自己的受控环境提供 |
| `HEXU_REQUEST_ID` | receiver 必填：该凭据绑定的确切请求 |

Codex 的 stdio MCP 配置结构示例（仅配置形状，不代表已安装或通过真实客户端验收）：

```toml
[mcp_servers.hexu]
command = "node"
args = ["/absolute/HEXU/dist/apps/mcp/src/main.js"]
env_vars = ["HEXU_AGENT_TOKEN"]
startup_timeout_sec = 15
tool_timeout_sec = 30

[mcp_servers.hexu.env]
HEXU_CONTROL_URL = "http://127.0.0.1:4310"
HEXU_AGENT_ROLE = "requester"
```

不要把 token 写入 TOML；由所有者按自己的凭据管理方式把环境变量提供给启动进程。发行/安装/保存真实持久访问须单独授权；本轮只交付代码与可丢弃 fixture，没有替用户修改本机或连接真实账号。使用桌面环境变量的实际传递方式及客户端审批策略仍需实机确认，不承诺本示例能自动跨进程取得某个终端的环境。

## 协议与工具

MCP 经典 stdio，固定支持 `2025-11-25`：`initialize` 协商版本，客户端确认支持后发 `notifications/initialized`；再执行 `tools/list` / `tools/call`。`ping` 可用。未支持版本返回本端支持版本，客户端不能接受则断开；没有宣告 resources、prompts、sampling、MCP tasks 或 Events。工具输入严格拒绝未知字段和不匹配类型。完整机器 schema 在 [tools.ts](../../apps/mcp/src/tools.ts)，HTTP 契约在[18](../development/18-data-api-catalog.md)。

| 工具 | 发起端 | 有限接收端 |
| --- | --- | --- |
| `hexu_discover_capabilities` | 当前固定目标的可用目录；不是事务授权 | 无 |
| `hexu_read_materials` | 仅初始固定选材，返回用于选择的 materialIds | 单请求的指定输入修订 |
| `hexu_preview_request` | 问题/澄清及原材料子集的预览 | 无 |
| `hexu_create_request` | 保存原 Assistance | 无 |
| `hexu_list_requests` | 本人 Agent、固定 Task 与授权内请求 | 只返回配置绑定的一个请求，不是新请求 inbox |
| `hexu_get_request` | 当前授权内请求与回应 | 仅绑定请求 |
| `hexu_find_creation` | 根据原 operationKey 只读核对创建回执 | 无 |
| `hexu_revise_input` | 保存新输入修订；本请求已移除的材料不能重新加入 | 无 |
| `hexu_respond` | 无 | accept/decline/request_input/propose_scope/answer |
| `hexu_cancel` | 取消后续分享/回应 | 无 |

写工具要求调用方保存稳定 operationKey。回答绑定 inputRevision/inputHash/accessRevision；读取与工具发现不启动工作。返回值同时提供 JSON 文本和 structuredContent；JSON-RPC封包错误/未知工具使用协议错误，工具输入校验/业务拒绝使用 `isError:true`。`decline` 是成功保存的业务回应，不是运行故障。

每次工具前检查独立身份与控制 API 版本；业务路由仍在事务内核对当前权限。HTTP 使用 `x-hexu-agent-api: 1`、不跟随重定向、10秒时限、8MiB响应上限（覆盖原200条有限回应的UTF-8上界）。stdio单进程每分钟最多120次工具调用，超限不发业务动作；单帧128KiB并串行处理，断流未完成帧不执行。桥不自动重试任何写入，也不在本地维护第二业务状态。

## 未知结果与恢复

- 创建响应丢失：保留原 operationKey，重启桥后 `hexu_find_creation` 查原回执；若 recorded，则读取该 requestId。
- `not_recorded` 只是该时刻观察，不保证其他进行中提交不会随后出现；不要另起新键重复创建。明确重试只可沿原键原包，不自动触发模型。
- 回应或补充响应丢失：先 `hexu_get_request` 核对版本/回应；重复同键同包只确认原事务。撤权优先于旧回执。
- 取消只阻止后续协作分享与回应；没有外部执行停止确认。没有模型付费创建，因而也不会把接受 ACK 当作模型启动记录。

## 与所选真实两端的差距

本地 Codex 的 MCP 工具入口与 Codex App Server/SDK 的线程继续是不同协议。官方 SDK 可按原 threadId 恢复，但本片未实现消费关联或原线程继续；不能用再启动一个新 Codex 会话替代切片4。

官方 dot 插件 Events 当前要求 **MCP2.0 / `2026-07-28`** 的 `server/discover` 和 `events/list|subscribe|unsubscribe`，另需认证端点、持久订阅、HTTPS回调验证/签名投递。这里的经典 stdio 工具桥不能冒充已接通 dot 插件。片5负责安全远端传输及接收 bootstrap，真实账户配置/事件订阅/模型费用和跨成员闭环仍未验证。preview/team-local 回环限制未放宽，禁止隧道临时公开。

官方依据（2026-10-08读取）：[MCP生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[stdio传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[Codex配置](https://learn.chatgpt.com/docs/config-file/config-reference)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[dot MCP Events](https://developers.openai.com/plugins/build/mcp-events)。
