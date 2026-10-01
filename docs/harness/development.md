# 开发流程 harness

> 按需读取：接手工程、调整服务/包边界、选择验证方式，或准备提交交付。

## 开工与范围

核对 `git status`、当前分支、远端进度和用户要求。用户已指定工作时完成该工作；只有“继续计划”才用 [22](../development/22-next-delivery.md) 选下一项。需求明确时自主处理常规实现与可逆验证，不逐步索要批准。

使用 `codex/` 功能分支；共享 main 仅快进同步，不强推、不自动 stash 或覆盖别人的修改。复用可用工作副本；清理前核对活动进程与未入 Git 的用户数据。分支合并、代码发布和生产部署是不同动作，按用户授权范围执行。

## 代码分层

| 路径 | 职责与边界 |
| --- | --- |
| `apps/web` / `packages/ui` | React/Vite、页面与共享控件；renderer 不持有进程/凭证职责 |
| `packages/client` | 浏览器 HTTP；会话凭证不放浏览器存储或普通 JSON |
| `apps/control` | 回环 Fastify API、身份与请求编排；team-local 不使用宿主原生运行时 |
| `packages/contracts` | 无依赖 DTO 与严格请求校验 |
| `packages/domain` | 纯领域规则，不导入 React、数据库或 provider |
| `packages/db` | 分模式 SQLite、迁移、当前权限、事务、幂等与 outbox |
| `apps/runner/src` | preview runtime、独立 CLI/agent、进程/目录/私有凭证 |
| `packages/adapters` | mock 不执行；Claude/Codex 协议各自实现，不互相复制协议 |

服务端 TypeScript 保持显式 `.js` import。协议/迁移从依赖关系和实际消费者入手；不借当前功能引入无关通用框架。当前版本与锁定依赖看 [package.json](../../package.json) / [lockfile](../../package-lock.json)，目标架构看 [工程 ADR](../engineering/README.md)。

## 最少足够的验证

Node 24 + npm；Linux 源码构建还需本地 `cc` 与 libc 头文件，用于编译[恢复发布助手](../../apps/runner/src/native/restore-publish.c)，不自动下载编译器。全新工作副本先 `npm ci`。命令以 [package.json](../../package.json) 为准。

| 改动 | 首选检查 |
| --- | --- |
| 文档/链接 | 本地链接与锚点、引用命令、规则归属及差异；无需重跑业务全套 |
| TypeScript 契约/逻辑 | `npm run typecheck`，相关现有工程测试 |
| UI/交互 | `npm run check:ui`、构建及受影响的浏览器流程；按实际问题看深浅色/窄屏/焦点 |
| 权限/事务/执行 | 对应专题的冲突、回执、撤权、重启/进程测试；高风险路径用 Linux 真实协议夹具 |
| 需要整体验证 | `npm run check`（类型、UI token、工程测试、构建）和 `npm run test:e2e` |

工程测试需先 `npm run build:server`，再可用 `node --test dist/tests/<相关文件>.test.js` 定向执行。`npm test` 包含服务端构建；不要对旧 dist 声称源码已通过。

提交前 `npm run format` 与 `git diff --check`。不为可逆低风险改动机械新增测试；只在新修改、失败或具体未解疑点出现时扩大/重复检查。

浏览器测试用独立可丢弃 `.hexu/e2e` 数据，不使用主预览/业务库。完整 POSIX 原生/节点流程以 Linux 为准，macOS 未验证，Windows 原生执行不支持。可用仓库只读 CI 验证，不绕过浏览器管理策略、不放宽认证/超时/重试或把协议替身计作真实模型。

### 延迟读取与失败清理

测试已取消/晚到的GET时，按旧页面或编辑会话挂起所有匹配读取，不假定一次打开只发一个请求。Workbench/SSE版本变化可以取消并重读；times:1或++seen===1会让替代请求提前完成，既可能使加载断言抖动，也可能漏测迟到回应。确认旧会话关闭或导航完成后先停止新增捕获，释放并等待所有已捕获回应，之后再移除拦截并检查当前草稿、内容、权限与URL；不能先unroute/unrouteAll再fulfill仍挂起的Route。需要复现刷新时用明确的真实事件或状态条件，不用延长超时/重试掩盖竞态。一次性写请求ACK丢失是不同场景，不机械改成全部拦截。

浏览器超时可能先关闭页面；路由/上下文清理失败仍须关闭测试服务，并保留原断言失败，不让二次清理异常覆盖诊断。参考[成果分页](../../tests/e2e/project-results.spec.ts)和[工作说明](../../tests/e2e/task-edit-baseline.spec.ts)。

## 交付与记录

交付说明改了什么、实际运行了哪些检查和未解决项。更新原 [19](../development/19-work-items.md) 的状态/依据/剩余范围；能力摘要与验证入口在 [21](../development/21-implementation-status.md)，下一项只在 [22](../development/22-next-delivery.md)，详细历史归档规则见 [文档治理](documentation.md)。不能根据文档或 mock 输出提高完成状态。

`.hexu/local-environment.md` 只记录可选本机路径/端口，不是可移植产品能力。凭证、数据库、真实数据截图不入 Git；不添加未经要求的许可证或修改仓库设置。没有真实 provider 凭证时继续可独立验证的产品工作，如实保留联调未验证状态。
