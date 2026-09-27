# 有限文本的 AI 协助

本批为 HX-DEV-11-04/05/06 的 **team-local、项目任务、本人节点、Claude Code** 切片。真人协助不变；Codex、私有任务 AI 协助、自动追问、文件/diff 材料、跨电脑与真实账户联调未交付。

## 使用与单独同意

在项目任务的一条人工讨论或已有 AI 回复下选择“请 AI 分析片段”。填写问题，选定单个片段，再选择本机单独授权文本协助的节点。查看完整问题/片段与工具、模型配置、预算参数，分别确认材料发送和账户费用后启动。默认没有选区，不自动发送整条消息、任务标题/说明、其他讨论、项目约定或真人协助回复。

节点须已在同一项目配对。沿用本机 enable-execution 的 JSON 配置，另外明确添加 `"textAssistance": true`；现只接受 `tool: "claude-code"`。重新执行 enable-execution，在本机阅读范围后输入 EXECUTE，再 start。旧配置省略该字段时没有 AI 文本派发能力；网页不能自行启用，也不能指定 executable、API key、目录或原生会话 ID。

此选项附加于当前节点授权，不取消原有目录执行能力；该次文本派发不使用目录。普通授权示例：

```json
{
  "tool": "claude-code",
  "executable": "/absolute/path/to/claude",
  "mode": "read-only",
  "workspaces": ["已配对的目录别名"],
  "timeoutSeconds": 300,
  "maxTurns": 8,
  "maxBudgetUsd": 1,
  "textAssistance": true
}
```

路径与别名由节点所有者填写。API key 仍只在节点本机环境中配置，不写入 JSON 或控制服务器。本批节点仍一次处理一个执行；节点忙或已有预约时明确不可用，不抢占主运行。另一个可用本人节点可承担辅助工作。没有系统沙箱、跨电脑安装或额度池承诺。

## 文本运行边界

每次新建空的私有临时工作目录及 HOME/CLAUDE_CONFIG_DIR，不复制项目文件，不继承原生历史。命令使用 `--bare --restricted --no-session-persistence --tools "" --disallowedTools "*"`，禁用 Hooks，显式空 MCP，`dontAsk` 和受控系统提示。除了提供方本身的模型通信，不提供网络工具、文件工具、Shell、技能或插件。CLI 参数含义参考 [Claude Code 官方 CLI 文档](https://code.claude.com/docs/en/cli-reference)，但本仓库没有据此声称真实模型已联调。

这些是受信任 CLI 的工具边界，**不是操作系统沙箱**，不能约束恶意或篡改的 executable。启动前能力检查只核对必要参数和版本，不能证明账户有效或模型互操作；每次实际初始化还核对空工具/MCP、dontAsk、临时 cwd 和会话身份。工具调用、权限拒绝事件/结果、边界不符、缺失结束事件、错误会话或失败结果不会发布成功建议，不降级到有目录的模式。

只保存最终有界建议到协助回复，不共享原始 thinking、工具参数或中间输出。不保留供恢复使用的会话。正常确认终止后删除临时环境；进程状态未知时保留，不依赖旧 PID 杀进程，不自动重跑。操作者可在本机以 `recover-execution --dispatch <id>` 并明确输入 `STOPPED <id>` 保存停止证据；文本恢复不释放其他运行的项目目录锁。未定位临时目录的清理仍需本机维护，不自动假装已清理。

已知密钥及临时目录会在本机输出中遮盖；输入的已知密钥模式也可能进一步遮盖。不是零泄漏/DLP 承诺，发起者仍需检查材料。界面的完整输入是固定的授权材料，不是精确的提供方收件回执。字符上限沿用 12000 预览、6000 选中片段和 2000 问题；不是 token 预算。CLI 美元预算参数和超时可见，但真实费用、模型接收与计费效果未验证，费用未知不能显示为零。

## 事务、权限与状态

复用 Assistance 和 Run（`purpose=assist`、`assistanceId`）；固定输入与哈希、model_text 授权、Run、dispatch、事件、幂等回执在同一事务写入。迁移 18 扩展授权种类并原样保留既有 snapshot_reply，绝不从真人同意补造模型同意。创建检查当前任务编辑权、源消息哈希/任务修订及本人节点/策略；同键不同内容拒绝，旧回执重新检查当前身份、任务和节点权限，只返回当前投影，不重新运行。

派发只接受冻结的问题/片段，不通过真人回复接口触发 AI，也不把真人线程静默转为 AI 会话。创建后新讨论不改写已授权文本；权限撤销、节点策略变化、过期及取消会阻止尚未许可的启动。节点持久化接单后申请一次性许可；许可不重放。节点再次核对本机授权，实际 spawn 才报告 running。

主编程最新/活动运行查询排除 assist，辅助运行仍出现在完整执行记录，并可回到协助详情。创建及执行不改 Task 修订/状态/负责人，不把其作为下一次编程接续来源，不绑定或释放项目 working-copy lock。仍遵守节点容量和待接续预约，未实现同节点并发。

成功的已确认终态只追加一次 agent 回复，随后 Assistance 为 responded；结果不自动采用、写代码或完成 Task。失败的 Run 与其固定材料继续可读，Assistance 可由发起者结束。活动 Run 不能直接“结束协助”；取消会撤销该 model_text 授权，并原子将本次 Run 置为 stopping，直到节点确实报告进程结束。迟到输出丢弃，已发生费用不能撤回。撤权仍按现有成员事务永久撤销旧协助，重新加入不会复活旧授权。

“已固定”“节点启动”“进程终止”“有效建议返回”分开显示；不把保存/ACK/许可当作 provider receipt。终态与回复/事件在同一节点事件事务内保存；重复终态不会制造第二条建议。

## API 与当前范围

`GET /tasks/:id/ai-assistance-options` 只给当前可编辑任务列出本人明确授权文本协助的同项目节点，不包含普通任务上下文。`POST /tasks/:id/ai-assistances` 返回 201 + AssistanceDetail，接受以下严格字段：

```text
sourceMessageId, expectedSourceHash, expectedTaskRevision,
range: { start, end }, question, nodeId, policyHash,
confirmMaterial: true, confirmExecution: true
```

范围为原文 UTF-16 偏移，沿用文字簇键盘与 CRLF/CR 映射。读取、取消和列表复用 `/assistances`；浏览器 Cookie 与节点 Bearer 仍分离。AI 输出详情遵守父任务权限，不新增真人有限授权。

现有 AI 文本切片只用 Claude Code，真实官方 CLI/账户的有效生成仍未实测。未包含 AI 连续追问/恢复、文件或代码差异材料、私有任务到节点的绑定、Codex 等价无工具执行、成本账本、跨空间/跨机器服务。下一步按同一 22 推进建议的明确局部采用，不把有限文本运行当作完整代码审阅或并行执行。


## 验证记录

功能头 `f49921f330238f89e601f79abfd68b6429291787` 通过 [只读 Linux CI 36320009916](https://github.com/ntygod/HEXU/actions/runs/36320009916)：格式、双端类型、生产构建、291/291 工程检查与 83/83 Chromium 流程，零失败、跳过或重试。新增 12/3 检查包含真实 HTTP 与独立协议子进程、固定输入、空临时目录、主现场不变、工具/权限请求拒绝、取消与未知恢复，以及选材、回执丢失、失败和深浅色/手机页面。实际产物 `10931622785` 的完整报告和 70—72 截图已复查。这证明应用与协议替身之间的流程，不代表真实 Claude 账户生成、计费、模型收件或 OS 沙箱验证；完整记录与剩余范围沿用 [21](../development/21-implementation-status.md)。
