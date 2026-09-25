# E1b｜本机双工具与代码现场接续

2026-09-25。实验性本地接入，不是远程执行服务或正式团队部署。

## 已实现的工作路径

任务 → 继续面板 → 显式选择原生 Claude Code 或 Codex → 选择已配置工作目录 → 只读或文件修改 → 结构化输出 → 查看真实 Git 变更。停止等待受管进程组的实际结果；任务完成仍由团队决定，不增加业务验收步骤。

代码已接入本机 CLI 进程。工程测试使用明确命名的协议替身，包含真实子进程、临时 Git 仓库和文件修改。**尚未使用真实 Claude Code 与有效 Anthropic 账户进行端到端联调，不能把这些替身测试称为模型测试。**

## 环境与启用

使用 Node 24、Git 和自行安装的目标工具。Claude 与 Codex 可以只配置其一。Linux 已做本轮工程测试；macOS 使用同一 POSIX 路径但尚未实测；Windows 原生进程管理暂不支持，模拟模式不受影响。

在未跟踪的 `.env` 中设置：

```dotenv
HEXU_NATIVE_ENABLED=1
HEXU_NATIVE_ROOTS=["/absolute/path/to/a/disposable-git-checkout"]
# 可选：不是默认 PATH 中的 claude 时使用绝对路径
# HEXU_CLAUDE_BIN=/absolute/path/to/claude
```

另在本机环境提供 `ANTHROPIC_API_KEY`。也可放在未跟踪的 `.env`，但不要把真实值写进任何可提交样例或公共任务。官方 bare 模式不读取订阅登录或 OAuth，本实现只支持 API key，不支持 Bedrock、Foundry、第三方网关或共享订阅。是否允许使用相应账户由公司自身决定。

目录必须是 Git 工作树根目录，可以是已有仓库或独立 worktree；拒绝整个 HOME、系统根、重叠根及任意子目录。服务不自动 clone、reset、clean、stash 或推送。建议使用没有业务秘密的独立副本，并用专用系统用户运行。

执行器在服务启动时探测 `--version` 和 `--help`。要求 `--bare`、`--restricted`、`--tools`、`--permission-mode`、`--strict-mcp-config`、`--max-turns`、`--max-budget-usd`。CLI 不支持时停用入口，不会退回 unrestricted。探测不验证 API key 是否有效；余额、权限、模型和网络问题在真实执行时呈现。

## Claude 权限、数据与费用

只读模式仅启用 Read、Glob、Grep；文件修改模式增加 Edit、Write。使用 `dontAsk` 与明确工具白名单，其他请求拒绝。不启用 Bash、子 Agent、MCP、插件、仓库 Hooks 或自动读取 CLAUDE.md。用户可以在 HEXU 任务说明里补充所需约定。

“没有网络工具”不等于离线运行：Claude CLI 仍会向模型提供方发送上下文及工具读取的代码。开始前展示本次发送的任务说明与最近工作记录，文件按模型需要读取。本版本不能保证所有被读取的文件都能预先列出；不要配置含秘密的仓库。

原生权限约束和已知敏感文件过滤不是操作系统沙箱或通用 DLP。网页 diff 排除常见密钥文件与符号链接；模型输出仅作已知密钥模式过滤，任意秘密仍可能出现在输出和原生 CLI 本地记录中。不要把生产凭证提供给普通开发任务。

默认上限为 8 轮、300 秒和 1 USD 工具预算，API 允许有限范围内调整。网页可调整本次预算；预算依赖 CLI 实际实现和估算，已发出的请求仍可能计费，不承诺费用绝对零超额。工具报告费用明确标为估算，不计入虚假的精确公司账单。

## 继续与输出

每次执行创建独立 Run、输入快照、工具配置、前驱引用。跨工具继续还保存显式 sourceRunId、Git 基线、采集时间和变更路径。复用选定目录，但原生会话恢复与运行中追加要求尚未接入；新执行使用当前任务和最近工作记录，不宣称完整恢复以前的内部上下文。

Claude JSONL 事件保存可显示文本、工具名称、警告和估算；不默认保存 thinking、完整工具参数或文件读取结果。API 事件分页最多 200 项，网页目前展示第一批和最终说明。接收到合法 result 且进程正常结束才显示执行结束；不因自然语言“完成了”或退出码 0 单独判定成功。

Git 页面展示整个授权工作树的当前变化，也可能包含执行前或外部 IDE 产生的改动，不把全部变化归功于 AI。只显示大小受限文本；未跟踪目录不会默认递归读取。

## Codex App Server

自行安装 Codex；设置 `OPENAI_API_KEY`，必要时设置绝对路径 `HEXU_CODEX_BIN`。不使用个人 ChatGPT 登录或其他成员的订阅、Key。程序检测不等于账号有效。

每个 Run 使用单独 App Server 进程、临时 HOME/CODEX_HOME、API key 内存认证。初始化后先读取并核对配置，符合策略才发送 API key；退出确认后清理临时目录。不开启整组 experimentalApi。请求有超时和数量边界，不因无回复重发模型请求。

线程使用 `thread/start`；本次工作使用 `turn/start`；原生 thread/turn 和实际 model 被记录在 Run。线程 sandbox 枚举使用 `read-only / workspace-write`，回合策略类型使用 `readOnly / workspaceWrite`，不能混用。配置以完整的 `projects={...}` TOML 映射声明目标目录为 untrusted，避免将引号错误存入路径键；自动项目配置被跳过。空 Hooks 允许命名的空数组，存在实际 Hooks、插件或 MCP 时拒绝。

本轮主动关闭 Shell、统一命令执行、Web 搜索、Apps 和多 Agent 等能力。Codex 只读分析主要使用传入材料；文件修改依赖原生可用文件能力，不能假定关闭 Shell 后仍可随意检索整个仓库。工作区写策略关闭工具网络并限制写目录；这些是原生策略，不保证抵御恶意 CLI 或所有操作系统层面的访问。项目内任意秘密不因网页 diff 过滤就自动被原生工具禁止读取；仅授权不含秘密的独立副本。

主动点击“从 Codex 读取模型”才读取 model/list（最多 10 页），不会开始生成。可手动指定模型；不硬编码模型排名。目录可返回缓存或当前账户范围内的配置，不代表一定有权限调用。API key 不出现在 argv、日志、模型提示或持久化配置中。

Codex 默认每个 HEXU Run 建立一个原生 turn，时间上限默认 300 秒；没有实现美元硬预算或按 token 精确计费。仅展示工具报告的 token，金额未知。UI 不显示 Claude 的美元预算控件来冒充 Codex 支持该功能。

停止先发送 `turn/interrupt`，等待目标结束事件，必要时收敛到受管进程组停止。只有真正确认进程退出才释放目录；收到 RPC 响应本身不算停止。额外执行权限与未接入澄清请求默认拒绝，记录原因，不自动扩权。原生成功必须有匹配 thread/turn 的完成事件，退出码或自然语言不能单独判成功。

## 同机跨工具继续

上一原生执行结束后，继续面板自动显示来源、沿用的目录和两种工具。切换工具或模型会重置本次发送/费用确认；两种工具的密钥互不混用。读取来源与新建执行前再次检查任务、目录与最近执行，过期/跨任务来源拒绝。

不要求 Git commit、push、stash 或创建正式交接单。已有未提交代码留在同一个目录，接续材料包含任务与近期记录、当前 Git 基线、最多 6 个文件/16000 字符的变更摘录。缺失或截断明确说明；活动工作树仍可能被外部 IDE 修改，摘要不等于整个现场的无损快照。

原执行还在工作时，先请求停止并等待，再点击开始。当前没有实现后台等待 Operation、页面关闭后自动开跑、同工具原生 resume、实时追加、跨电脑迁移或完整项目知识组装。完成任务后继续需要显式重开；不会因为 AI 结束而自动完成任务。重复请求返回同一 Run，不重复付费启动。

### 无模型协议检查

使用经官方发布摘要核对的 Codex 0.157.0 Linux 包，本轮执行了 initialize/config/read，核对空 Hooks、精确目录键和不信任项目覆盖行为；同时按该 CLI 导出的 JSON Schema 检查线程/回合及授权响应结构。这些不含有效账户、模型生成或真实产出质量测试。

```bash
npm run check:codex-protocol -- /absolute/path/to/codex
```

只在显式提供 CLI 时运行，不进入常规无凭证模拟 CI 的前置条件。当前完整流程使用测试协议替身执行真实临时文件操作，不能把替身标为正式提供方。

## 停止、崩溃与恢复

Claude 停止向本次创建的 POSIX 进程组发送 SIGTERM，必要时升级 SIGKILL，等待实际结束后再解除目录占用。范围是受管进程组，不保证能杀死恶意脱离进程组的进程；不把该机制宣传为完整安全沙箱。

服务异常退出后不会重新启动旧调用，也不会通过旧 PID 猜测并杀进程。旧运行保留“状态未知”和目录占用。正常关闭会尝试停止当前受管运行。

恢复步骤：先退出所有使用同一数据库的 HEXU 服务，在操作系统中确认旧 Claude / Codex 及其子进程已经停止，并检查工作目录中的修改。然后对界面提示的具体 Run 执行：

```bash
npm run native:recover -- <runId> --confirm-process-stopped
```

该命令记录你的人工确认并解除历史占用，不自动证明进程已停，也不撤销文件修改。没有确认就不要运行。随后重启服务，选择重新执行。不要并行运行两个服务实例访问同一 SQLite 文件。

## 本轮没有提供

真实多人认证、PostgreSQL、独立 Runner 配对与 WSS、跨电脑交接、运行中追加、原生会话恢复、通用终端、Bash 测试命令、任意远程预览和公网部署均未完成。原有订单预览仍是虚构示例。

## 官方依据

核查日期：2026-09-25。实现仍需按本机实际版本联调。

- [程序化运行与 bare 模式](https://code.claude.com/docs/en/headless)：非交互启动、默认配置自动加载风险、API-key 认证、流式结果和估算费用。
- [CLI 参数](https://code.claude.com/docs/en/cli-reference)：restricted、工具选择、权限模式、模型和预算参数。

这些资料支持接入设计，不证明本仓库已经通过真实提供方测试。

- [Codex App Server](https://developers.openai.com/codex/app-server)：双向协议、模型目录、线程/回合和中断。
- [Codex 配置](https://developers.openai.com/codex/config-reference)：内存认证、项目信任与受限配置。
- [Codex 0.157.0 官方发布](https://github.com/openai/codex/releases/tag/rust-v0.157.0)：本轮无模型协议检查版本，不是自动升级承诺。
