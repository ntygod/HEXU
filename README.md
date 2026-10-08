# HEXU · 合序

让人和 AI，一起交付。

HEXU 是面向**个人多工具/多模型 coding**与**团队 AI coding**的研发协作工作台。一个 Task 集中目标、讨论、上下文、执行记录和成果，支持持续工作与有边界的协助。

下一阶段围绕**跨 Agent、跨成员协作**推进本地与云端双向接入，见[协作与云端接入规划](docs/product/10-agent-collaboration-plan.md)。这是新增产品目标，当前可用范围仍以下文和实现进度为准。

## 当前能用到什么

现有工作台、项目/任务、资料与约定、草稿与建议采用、同机节点执行/接续等已接入。产品目标是桌面优先、团队服务可选、保留 Web 协作入口；当前仍是开发版本。

| 模式 | 适用范围 |
| --- | --- |
| 默认 `preview` | 虚构单用户工作台，默认使用不调用模型的模拟器；可另行显式配置实验性本机原生工具 |
| 可选 `team-local` | 真实账号、空间与项目权限；执行由本人单独授权的独立节点承担 |

**两种模式都只支持同机回环访问。** 桌面安装包、Windows 原生执行、跨电脑部署与有效账户真实模型生成/恢复联调尚未交付或验证。示例订单预览不是用户项目的通用预览。当前能力、限制与实际验证统一看 [实现进度](docs/development/21-implementation-status.md)。

## 快速启动

使用 Node.js 24 与 npm，依赖由 `package-lock.json` 锁定。Linux 源码构建还需 `cc` 与 libc 开发头文件，用于编译[检查点排他发布组件](docs/engineering/checkpoint-restore.md)；构建不会自动下载编译器：

```bash
git clone https://github.com/ntygod/HEXU.git
cd HEXU
npm ci
npm run dev
```

开发网页：<http://127.0.0.1:5173>，本地 API 默认 4310。

构建后可用一个本地进程提供网页、API 与事件：

```bash
npm run build
npm start
```

访问 <http://127.0.0.1:4310>。默认数据在 `.hexu/preview.sqlite`，首次填充虚构示例，重启保留记录。默认不启用原生执行，无需模型密钥，也不产生模型费用。

可复制 [.env.example](.env.example) 为未跟踪的 `.env`。配置、数据和排错见 [本地启动说明](docs/engineering/local-preview.md)。服务拒绝非回环地址，不通过隧道或反向代理将本版本公开到外网。

## 按需要启用

| 想做什么 | 入口 |
| --- | --- |
| 使用真实账号、邀请成员和项目权限 | [本机账号模式](docs/engineering/team-local.md) |
| 配对节点，再单独授权本人执行 | [节点配对](docs/engineering/runner-node.md) / [独立执行](docs/engineering/runner-execution.md) |
| 在 preview 中配置 Claude Code / Codex | [原生执行](docs/engineering/native-execution.md) |
| 学习资料、约定、草稿、协助、检查点等功能 | [使用与工程指南](docs/engineering/README.md) |
| 了解完整目标、设计和客户端形态 | [文档导航](docs/README.md) |
| 接手或继续开发 | [AI 接手指南](docs/development/24-ai-handoff.md) / [AGENTS.md](AGENTS.md) |

摘要配对不授予执行权；实际调用模型需要本机明确配置和授权。不要在任务、源码或截图中放置真实凭证。

## 开发

```bash
npm run typecheck       # 前后端类型
npm run check:ui        # UI tokens
npm test               # 服务端构建与工程测试
npm run build          # API 与网页构建
npm run format         # 格式化源代码
npm run test:e2e       # Chromium 流程，独立可丢弃数据
```

首次浏览器测试需要 `npx playwright install chromium`。按改动选检查，完整原生/节点回归使用 Linux 与协议替身；平台限制和验证方式见 [开发 harness](docs/harness/development.md)。

| 代码 | 职责 |
| --- | --- |
| `apps/web` / `packages/ui` | React/Vite 工作台、共享控件与唯一运行 tokens |
| `apps/control` / `packages/client` | 本地 API 与浏览器客户端 |
| `apps/runner` / `packages/adapters` | 进程、工作目录、节点与工具协议 |
| `packages/contracts` / `packages/domain` | 公共 DTO、校验与纯领域规则 |
| `packages/db` / `packages/identity` | 分模式持久化、事务、权限与身份 |

产品范围以 [v1.1](docs/product/03-functional-specification.md) 为准，原 102 项工作与剩余范围见 [工作清单](docs/development/19-work-items.md)，下一项只在 [交付计划](docs/development/22-next-delivery.md) 维护。

## 仓库与数据

不提交真实客户数据、模型凭证、生产配置、`.env` 或本地数据库。代码许可证尚未由仓库所有者确定；依赖许可证见 [依赖说明](docs/engineering/dependencies.md)。
