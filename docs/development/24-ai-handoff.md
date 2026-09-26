# 24｜AI 接手开发指南

更新：2026-09-26（UTC+8）。本页是接手入口，不另建功能清单或进度总账。

## 1. 从哪里开始

1. 先读根 [AGENTS.md](../../AGENTS.md)，检查 `git status`、当前分支和远端进度。保留其他人的改动；共享主分支同步使用 fast-forward，不强推、不自动 stash。
2. 读 [21｜当前实现进度](21-implementation-status.md) 确认可用、模拟和待实现范围，再读 [22｜下一步交付](22-next-delivery.md) 选择下一项。原 102 个工作项及状态只在 [19](19-work-items.md) 维护。
3. 修改行为前读 [产品 v1.1](../product/03-functional-specification.md) 及本次相关工作包；UI 同时读 [Workbench W1](../design/README.md)，客户端／部署边界同时读 [ADR-0008](../engineering/adr-0008-client-surfaces.md)。无需每次重读全部计划。

**W1-01—09 已完成。** 旧页面布局、大 `styles.css` 和旧配色别名已删除，不再重新启动 UI 重建。`App.tsx` 只组织路由和全局入口；组件及样式归属见设计文档第 9 节。参考 HTML 和 Figma 是设计资料，不能供给生产状态、模型列表或工具能力。

业务底座为 E2c2：preview 是明确的示例身份；team-local 使用真实账号／项目权限和可选本人授权节点。两者都只支持回环地址。SSH 能登录一台测试机，不等于产品已交付跨电脑节点或公开部署。桌面宿主尚未选定，不能因为前端完成就添加 Electron／Tauri 或宣称客户端已交付。

## 2. 下一项的具体入口

默认继续 **HX-DEV-04-01：任务负责人/参与者**，先做项目可见任务的真人负责人修订式改派，联动 03-03/06、04-03/06 和任务工作区。项目基本设置、归档/恢复与执行联动已经接入，不重复实施；范围以 [22](22-next-delivery.md) 为准。

| 工作 | 先查看 |
| --- | --- |
| 任务归属、状态与界面 | [04 工作包](04-tasks-requirements.md)、[Task 契约](../../packages/contracts/src/index.ts)、[任务事务](../../packages/db/src/store.ts)、[任务工作区](../../apps/web/src/task-workspace.tsx) |
| 已交付的项目基本设置 | [设置事务](../../packages/db/src/project-settings.ts)、[严格契约](../../packages/contracts/src/project.ts)、[W1 抽屉](../../apps/web/src/project-settings.tsx)、[回归](../../tests/project-settings.test.ts) |
| 项目基础和成员管理 | [03 工作包](03-identity-projects.md)、[协作数据](../../packages/db/src/collaboration.ts)、[团队页面](../../apps/web/src/team.tsx)、[项目页面](../../apps/web/src/projects.tsx) |
| 权限、持久化和事件 | [权限](../../packages/db/src/permissions.ts)、[迁移](../../packages/db/src/schema.ts)、[控制 API](../../apps/control/src/app.ts) |
| 已交付的归档/恢复 | [生命周期事务](../../packages/db/src/project-lifecycle.ts)、[W1 控件](../../apps/web/src/project-lifecycle.tsx)、[使用说明](../engineering/project-archive.md)；恢复不重新派发 |
| 归档和派发/接续联动 | [节点派发](../../packages/db/src/node-execution.ts)、[节点接续](../../packages/db/src/node-continuations.ts)、[节点执行器](../../apps/runner/src/agent/executor.ts)；归档不等于进程结束 |
| 已补齐的双工具恢复路径 | [Claude 会话](../engineering/claude-sessions.md)、[Codex 会话](../engineering/codex-sessions.md)、[任务运行界面](../../apps/web/src/node-execution.tsx)；不要再次将 Claude resume 写为未实现 |

双工具显式恢复仅是有界、实验性的节点代码路径。真实账户生成/成功恢复依旧未联调，不把协议替身或无模型兼容性检查计作模型验证。历史默认不保留、仅本机明确授权、同任务/节点/目录/工具/账户/策略绑定、恢复失败不静默新建和未知进程保锁等规则继续适用。

## 3. 代码查找图

| 范围 | 实现入口 |
| --- | --- |
| 页面与请求状态 | [前端入口](../../apps/web/src/App.tsx)、[身份边界](../../apps/web/src/identity.tsx)、[状态与内存草稿](../../apps/web/src/state.tsx)、[HTTP 客户端](../../packages/client/src/index.ts) |
| 视觉与控件 | [唯一运行 tokens](../../packages/ui/src/tokens.css)、[共享控件](../../packages/ui/src/index.tsx)、[基础样式](../../apps/web/src/foundation.css)；页面样式随所属功能维护 |
| 请求与领域规则 | [contracts](../../packages/contracts/src/index.ts)、[domain](../../packages/domain/src/index.ts)；纯领域规则不依赖 React、数据库或提供方 |
| 持久化与访问权限 | [store](../../packages/db/src/store.ts)、[权限](../../packages/db/src/permissions.ts)、[迁移](../../packages/db/src/schema.ts)、[节点执行事务](../../packages/db/src/node-execution.ts) |
| 本机 API 与执行 | [控制 API](../../apps/control/src/app.ts)、[Runner CLI](../../apps/runner/src/cli.ts)、[节点执行器](../../apps/runner/src/agent/executor.ts) |

模型执行、进程、密钥与工作目录继续由 Runner 负责，不迁入页面点击处理器。任务完成不等于执行结束；停止请求不等于已确认终止；Operation 成功仅表示 Run 创建。源码中的实际契约优先于早期计划里的接口草案。

## 4. 环境与最少足够的验证

使用 **Node 24 + npm**，先核对 `node --version`。新工作副本执行 `npm ci`。常规开发见根 README 的 `npm run dev`；构建后使用 `npm run build`、`npm start`，保持回环监听。

- 提交前执行 `npm run format`，用 `git diff --check` 检查差异。
- 按改动选择现有检查：`npm run typecheck`、`npm test`、`npm run build`；`npm run check` 已包含这三项。
- 行为或布局改动复用 `npm run test:e2e`。浏览器用例使用当前工作副本的可丢弃 `.hexu/e2e` 数据及 4310/4311/4312 端口；不复用用户主库或已占用的真实服务。浏览器运行环境未准备好时，可使用仓库 Linux CI 并明确实际验证平台。
- 原生／独立节点的完整回归以 Linux 为准；macOS 未验证，Windows 原生执行不支持。Windows 可以做页面、格式、类型与构建检查，不能据此宣称进程和凭证边界跨平台完成。
- 测试必须使用明确协议替身和虚构 Key，不使用开发者或提供方凭证。`check:codex-protocol` / `check:claude-protocol` 是可选无模型检查，不使用真实账户或发起真实模型 turn。

W1 功能提交 `43c066f` 已通过 [Linux CI 36238774668](https://github.com/ntygod/HEXU/actions/runs/36238774668)：175 条工程测试、35 条浏览器流程，均无失败、跳过。后续提交的实际结果仍看 [21](21-implementation-status.md) 和对应 CI；不因本页重复运行未受影响的整套测试。

## 5. 协作与交付收尾

开工从最新 `origin/main` 建立 `codex/` 分支，或核对已有工作树后复用。变更实现、必要界面和相关文档一起提交，更新 19 的原工作项状态／依据／剩余范围及 21 的实际结果；如下一步变化，更新同一份 22，不创建竞争路线。

合并前确认目标提交与 CI、远端变化及未提交文件；保持原工作项 ID 和提交历史可追踪。清理工作树前检查仍在运行的预览／执行进程以及未入 Git 的需要保留文件。工作树仍承载预览时不要直接删除。

`.env`、本地 SQLite、节点私有状态、凭证、实际数据截图和临时验证脚本不入 Git。本机可能有被忽略的 `.hexu/local-environment.md`，记录当前预览和可选测试环境；它不是仓库安装前提，也不改变产品部署边界。新机器没有该文件时仍可按 README 和 Linux CI 开发。
