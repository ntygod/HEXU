<div align="center">

# HEXU · 合序
### 让人和 AI，一起交付。
**面向人和 AI 的研发协作工作台**

</div>

不用反复解释，不用反复追问，不用四处找成果。


> **当前阶段：E1c 本机持久化接续。** 已实现实验性 Claude Code CLI、Codex App Server 接入，以及同一任务和 Git 工作目录内的显式接续。默认仍是无密钥模拟预览。**没有调用真实模型或使用有效提供方账户；原生工作流程测试使用明确标识的协议替身。** 另已用官方 Codex 0.157.0 程序检查初始化与配置协议，但这不是模型生成联调。当前仍无多用户认证、PostgreSQL 和远程节点，不可作为公网团队服务。

## 启动

推荐 Node.js 24。依赖版本由 `package-lock.json` 固定。

```bash
git clone https://github.com/ntygod/HEXU.git
cd HEXU
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。开发命令会启动 TypeScript 监听、Fastify API 与 Vite 网页。

构建后可以只启动一个本地进程：

```bash
npm run build
npm start
```

此时打开 `http://127.0.0.1:4310`。页面、API 和事件流使用同一来源。

数据保存在 `.hexu/preview.sqlite`，重启不会清空。仅首次启动填充虚构项目、成员与订单示例。默认不启用原生模式，无需模型密钥，也不会产生模型费用。显式启用原生模式后会按所配 API 账户计费。示例身份固定为“林舟”，不代表真正的登录系统。

可复制 `.env.example` 为 `.env` 配置本地端口与数据目录；常规开发使用默认 API 端口 4310 与网页端口 5173。**服务拒绝非回环地址。不要通过反向代理或隧道将本版本开放到外网。**

## 当前能操作什么

| 能力 | 当前状态 |
| --- | --- |
| 工作台、看板／列表、任务工作区、成果页、浅深色和窄屏 | 真实页面与本地 API |
| 项目／任务、说明、讨论、完成／重开、文字成果及反馈 | SQLite 持久化，保留原有记录 |
| 事件更新、修订冲突和重复请求去重 | 已实现基础机制 |
| 无密钥体验执行、等待、回复和停止 | **模拟器**，不调用模型、不改代码 |
| 本机 Claude Code / Codex | **实验性原生适配**；独立 API 配置、进程与 Git 已实现，真实模型联调待完成 |
| 持久化接续 | 等待/请求停止后继续、刷新恢复、取消及需要处理提示；不把新执行创建当作任务完成 |
| 同机跨工具继续 | 同任务、同目录、保留未提交代码；新 Run、新原生会话、显式来源和上下文 |
| Codex 模型选择 | 手动指定或主动读取原生模型目录；目录不代表账户调用权限 |
| 显式目录授权、实际 Git 变更、结果输出与停止 | 已实现；测试通过协议替身执行真实本地文件操作 |
| 原生会话恢复／运行中追加要求／Bash／MCP | 尚未接入；新执行使用任务说明和最近工作记录 |
| 多成员登录、临时协助、并行分支、独立 Runner 和远程执行 | 尚未实现 |
| 示例订单预览 | 虚构业务示例，不是通用预览隧道 |

模拟名称不代表原生工具已接通。设置页分别显示 Claude Code / Codex 的能力探测与各自的 API 配置；工具检测可用不代表凭证有效或真实模型已经测试。

## 可选：启用本机原生工具

先准备一个不含敏感资料的独立 Git 工作目录，并在本机安装支持 `--bare`、`--restricted` 等必要参数的 Claude Code。缺少这些能力时不会降级到不受限调用。

复制 `.env.example` 为未跟踪的 `.env`，修改：

```dotenv
HEXU_NATIVE_ENABLED=1
HEXU_NATIVE_ROOTS=["/absolute/path/to/your/git-checkout"]
```

通过本机环境或未跟踪的 `.env` 设置自己的 `ANTHROPIC_API_KEY`，然后重启 HEXU。不要把真实密钥放入仓库、任务描述或截图。`--bare` 使用 API 认证，**不会复用订阅登录额度**。

进入任务 → **继续 → 使用本机原生工具** → 选择目录与只读／文件修改 → 查看本次上下文 → 确认本次数据发送和费用范围 → 开始。新执行仍属于原任务，不自动标记任务完成。

E1c 不开放 Bash、网络工具、MCP、仓库 Hooks，不能替你运行安装、构建或测试命令。CLI 调用模型本身仍需联网；文件工具约束不是操作系统沙箱。Linux 已做工程测试，macOS 的 POSIX 路径尚未经平台实测；Windows 原生执行暂不可用。详见 [原生使用说明](docs/engineering/native-execution.md)。


### Codex 与跨工具继续

在本机安装支持 App Server 的 Codex，单独提供 `OPENAI_API_KEY`；不在 PATH 时配置 `HEXU_CODEX_BIN=/absolute/path/to/codex`。只使用一个工具时只需它自己的密钥。

Codex 每次执行使用独立临时 HOME/CODEX_HOME，先核对配置，再经本地 stdio 传入 API key；不读取个人订阅登录或旧 Codex 配置。默认关闭 Shell、MCP、插件和 Web 搜索，使用只读或工作区写入策略。它不是完整的 Codex 终端功能；请提供需要的任务材料，不要依赖 Shell 读取、安装或测试。

已有原生任务点击 **继续** → 选择另一工具 → 查看沿用目录和接续材料 → 输入接下来要做什么 → 开始。默认新建原生会话，不要求先提交或推送代码。原执行仍活动时可选择“请求停止后继续”或“自然结束后继续”，安排会保存并可取消。只有确认停止且目录释放后才开始；任务说明变化、原进程未知或服务重启会提示处理，不会强行启动。不会把一个工具的凭证交给另一个工具。

接续包含任务说明、近期工作记录、Git 基线及最多 6 个变更文件的摘录，**不是完整会话或全部仓库内容迁移**。可以保留未提交修改，但不能迁移到另一台电脑。Codex 界面默认 300 秒超时，不支持美元硬预算；模型目录和用量保留来源，不虚构精确费用。

官方程序的无模型协议检查可运行：

```bash
npm run check:codex-protocol -- /absolute/path/to/codex
```

此命令只运行版本兼容的初始化与配置读取，不认证、不创建模型回合；使用临时目录，不读取用户凭证。完整限制见 [原生使用说明](docs/engineering/native-execution.md)。

## 开发命令

```bash
npm run typecheck       # TypeScript
npm test                # 领域、存储与 API 测试
npm run build           # API 和网页构建
npm run format          # 格式化源代码
npx playwright install chromium
npm run test:e2e        # 浏览器流程，使用独立测试数据库
```

CI 执行类型、测试、构建和浏览器交互检查，并保留截图与失败追踪。运行结果以具体 CI 记录为准。生产安全、实际团队效果和质量评估由内部团队安排，不变成 HEXU 的业务审批模块。

## 代码结构

```text
apps/web                 React + Vite 网页
apps/control             Fastify 本地服务
packages/contracts       DTO 与运行时输入验证
packages/domain          任务、执行与幂等语义
packages/db              SQLite 开发适配、迁移与事件
packages/adapters/mock   明确标识的模拟执行器
packages/adapters/claude-code  Claude JSONL 协议与受限文件工具配置
packages/adapters/codex        Codex 双向 RPC、模型目录和受限策略
apps/runner/src          本机进程与 Git 边界（尚非独立网络执行器）
packages/ui              共用组件与设计变量
packages/client          浏览器 HTTP 客户端
tests                    单元、存储、API 与浏览器测试
```

当前采用 TypeScript 和 npm workspaces。SQLite 是让本地预览无需额外数据库的阶段性选择，不替代规划中的 PostgreSQL 正式服务。背景与边界见 [工程决策](docs/engineering/adr-0001-local-preview.md)。

## 产品与开发文档

| 入口 | 用途 |
| --- | --- |
| [产品概要](docs/product/00-executive-brief.md) | 面向管理层的定位与完整目标 |
| [总体产品规划](docs/product/01-product-plan.md) | 最终范围与边界 |
| [人的工作旅程](docs/product/02-people-and-workflows.md) | 角色、继续、协助和接手 |
| [功能规格](docs/product/03-functional-specification.md) | v1.1 功能要求 |
| [UI/UX](docs/product/04-ux-and-design.md) | 工作台、任务与成果的页面规则 |
| [领域状态](docs/product/05-domain-and-state.md) | Task、Run、成果与真实状态的区别 |
| [技术架构](docs/product/06-technical-architecture.md) | 最终执行与协作架构 |
| [建设路线](docs/product/07-roadmap.md) | 完整目标的实施顺序 |
| [决策与资料](docs/product/08-decisions-risks-and-sources.md) | 原始依据与取舍 |
| [v1.1 修订](docs/product/09-planning-revision.md) | 已移除的强制流程 |
| [详细开发计划](docs/development/README.md) | 17 个工作包、102 个原始工作项 |
| [逐项任务状态](docs/development/19-work-items.md) | 原 102 项的真实状态、代码入口和剩余内容 |
| [下一步交付](docs/development/22-next-delivery.md) | 收口接续后补真实身份、权限与独立节点 |
| [当前实现进度](docs/development/21-implementation-status.md) | 本次完成、部分实现与后续工作 |
| [接口总表](docs/development/18-data-api-catalog.md) | 完整契约草案；当前实现子集见代码与状态文档 |
| [本地启动与问题处理](docs/engineering/local-preview.md) | 端口、数据库、模拟模式与已知限制 |

最终产品以“继续、协助、并行”组织不同人和 AI 的工作，保留工具选择和本地环境。当前首批代码没有改变这个目标，也没有把未实现的能力包装成现成功能。

## 自研与数据边界

本仓库自主实现产品和领域，合理复用基础依赖。原有规划文档保留；代码许可证尚未由仓库所有者确定，本次未添加 LICENSE。依赖使用其各自许可证，见 [依赖说明](docs/engineering/dependencies.md)。

仓库不得提交真实员工评价、客户数据、模型凭证或生产配置。`.hexu/`、`.env`、构建产物和测试临时文件被忽略。质量、效果和上线评估见 [内部评估边界](docs/engineering/internal-evaluation.md)。
