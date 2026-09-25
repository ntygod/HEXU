<div align="center">

# HEXU · 合序
### 让人和 AI，一起交付。
**面向人和 AI 的研发协作工作台**

</div>

不用反复解释，不用反复追问，不用四处找成果。

> **已开始应用开发：E0 本地开发预览。** 当前可以真实保存项目、任务、讨论、成果和完成状态；AI 执行由明确标识的模拟适配器提供。**尚未接入真实 Claude Code／Codex、多用户认证或远程执行，不可当作公网团队服务部署。** 产品规划 v1.1 与开发计划 D1 描述最终目标，并不代表全部已实现。

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

数据保存在 `.hexu/preview.sqlite`，重启不会清空。仅首次启动填充虚构项目、成员与订单示例。无需填写模型密钥，不会产生模型费用。示例身份固定为“林舟”，不代表真正的登录系统。

可复制 `.env.example` 为 `.env` 配置本地端口与数据目录；常规开发使用默认 API 端口 4310 与网页端口 5173。**服务拒绝非回环地址。不要通过反向代理或隧道将本版本开放到外网。**

## 当前能操作什么

| 能力 | E0 状态 |
| --- | --- |
| 工作台、项目看板／列表、任务工作区、成果页、深色主题 | 已实现前端页面与真实 API 联动 |
| 新建项目／任务、修改说明、等待标记、完成／重开／取消 | 已实现，真实保存到本地数据库 |
| 任务讨论、文字成果、版本关联的成果反馈、任务搜索 | 已实现本地数据流程 |
| 事件更新、修订冲突、重复请求去重 | 已实现基础机制 |
| 正常结束、等待回复、等待授权、失败与停止 | **模拟执行**，不调用模型、不改代码 |
| 订单筛选、分页与 CSV | **虚构业务预览**，用于体验成果页面 |
| 原生 Claude Code／Codex、真实代码目录、终端 | 尚未实现 |
| 多用户登录、成员接手、权限完备的团队协作 | 尚未实现 |
| 并行工作区、真实预览隧道、PostgreSQL、远程节点 | 尚未实现 |

模拟工具名称只表示正在演示哪种选择，不代表原生工具已被检测或授权。页面对尚未实现的操作明确禁用。任务完成不依赖测试报告；完成任务、模拟执行结束和真实发布是不同事实。

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
| [当前实现进度](docs/development/21-implementation-status.md) | 本次完成、部分实现与后续工作 |
| [接口总表](docs/development/18-data-api-catalog.md) | 完整契约草案；当前实现子集见代码与状态文档 |
| [本地启动与问题处理](docs/engineering/local-preview.md) | 端口、数据库、模拟模式与已知限制 |

最终产品以“继续、协助、并行”组织不同人和 AI 的工作，保留工具选择和本地环境。当前首批代码没有改变这个目标，也没有把未实现的能力包装成现成功能。

## 自研与数据边界

本仓库自主实现产品和领域，合理复用基础依赖。原有规划文档保留；代码许可证尚未由仓库所有者确定，本次未添加 LICENSE。依赖使用其各自许可证，见 [依赖说明](docs/engineering/dependencies.md)。

仓库不得提交真实员工评价、客户数据、模型凭证或生产配置。`.hexu/`、`.env`、构建产物和测试临时文件被忽略。质量、效果和上线评估见 [内部评估边界](docs/engineering/internal-evaluation.md)。
