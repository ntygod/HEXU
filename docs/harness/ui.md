# Workbench UI harness

> 按需读取：修改页面、样式、交互、输入、抽屉、主题或布局偏好。

## 先定位

读 [Workbench W1](../design/README.md) 的相关规则；任务工作区对照 [10 工作包](../development/10-task-workspace.md)，壳层/共享控件对照 [02 工作包](../development/02-design-system.md)。W1-01—09 已交付；[23](../development/23-workbench-rebuild.md) 记录迁移历史，不是再次清空前端的任务。

## 稳定约束

- 一个 Task 集中讨论、执行、上下文与结果，不另建 AI 会话任务。Task/Run/Operation、输入已保存/实际启动/provider receipt 分别表述，完成无需报告；选择并行结果不等于合并或停止其他工作。
- 暗色优先、青色主动作、完整浅色和紧凑/舒适密度。运行数值仅在 [tokens.css](../../packages/ui/src/tokens.css)；设计目录仅转引。不要另建调色板或恢复单体 styles.css。
- `foundation.css` 留给基础布局/表单/通用呈现，功能拥有自己的组件与样式。参考 HTML/Figma 用于信息结构，不供给真实成员、工具、模型或状态。
- 保留身份、权限、SSE、输入与接续行为。主题尊重用户显式选择；布局按身份/空间隔离；临时输入是 Provider 内存草稿，身份/空间变化或撤销编辑权后清除。明确保存的 AI Draft 是另一类业务记录，不受“临时草稿仅内存”混淆。
- 编辑基线固定；SSE 显示冲突，不静默替换草稿、选区或 expectedRevision。短暂读取故障保留编辑，旧的已取消读取不能卸载当前编辑器；确实撤权则清空。未知写回执确认同一请求体/幂等键，关闭不等于取消已提交工作。
- 共享 Task 完成/取消确认首次发送固定动作/正文/键；未知结果先恢复同 Task 原包，关闭不撤回服务端操作。当前撤权清除包括已收起的包；成功 ACK 后刷新失败只 GET。未发送的固定修订/新活动检查、旧会话晚回应隔离分别保留，见[项目任务约束](projects-tasks.md#task-完成取消重开与未知结果)。
- UI 按真实 provider/node policy 提供原生恢复；说明会继承旧原生历史，当前取消勾选不抹除历史。不能用新会话演示覆盖 provider 特定恢复边界。
- 使用语义标签、键盘等价操作及减少动态效果设置。新增同名动作时按语义容器定位测试；修改角色时同步相关浏览器定位器。窄屏既检查溢出也检查主内容实际可用宽度。

Figma 的选材/求助/接手结构可以采用；企业强制入口、任务与会话拆分、强制验证措辞、自动合并、成员/Agent 排名不采用。桌面优先与可选团队服务继续按 [ADR-0008](../engineering/adr-0008-client-surfaces.md) 执行，不能因为页面演示而加入 Electron/Tauri。

## 代码与验证

组件归属见 [设计文档的代码地图](../design/README.md#9-当前代码归属)。壳层在 [shell](../../apps/web/src/shell.tsx)，请求/内存状态在 [state](../../apps/web/src/state.tsx)，任务在 [task-workspace](../../apps/web/src/task-workspace.tsx)，共享控件在 [UI 包](../../packages/ui/src/index.tsx)。

复用 [workbench](../../tests/e2e/workbench.spec.ts) 与对应功能浏览器流程，重点核对本次改变的焦点、输入保留、明暗色、窄屏和异常。运行方式见 [开发流程](development.md)，不把每个样式修正扩大成全套测试矩阵。

涉及项目/资料/协助/执行语义时，再选 [专题索引](README.md) 对应指南；不在呈现层重写权限或模型派发规则。
