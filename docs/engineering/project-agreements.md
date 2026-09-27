# 从讨论保存项目约定

对应 `HX-DEV-05-03` 的本机切片。约定是成员明确发布的共享规则，与一般资料和 AI 原始建议分开。

在项目任务的真人讨论或可共享 AI 回复下点击“设为项目约定”，核对来源、编辑标题/正文并保存。保存后属于同一项目，不转移任务负责人、执行授权或私人账号。私有任务、其他项目的消息和系统状态消息不能通过此入口发布。

来源保存任务/消息 ID、当时的作者和时间、完整消息指纹与最多 1000 字符节选。消息较长时明确标识节选；编辑框最多预填 8000 字符并提示整理。人工发布者与原讨论作者分别记录。后续编辑只改约定正文/标题，来源保持不变；AI 自报批准不会自动成为约定。

“替代已有约定”需要主动选择同项目的当前有效约定，展示旧正文和来源。选择不会生效，明确保存才原子创建新约定，并将旧记录标为已替代、双向关联。替代后保留旧历史，不能重新启用旧记录；后续约定停用也不会复活前者。停用/启用沿用同一 ID，保留修订，可选停用原因。

项目“项目约定”标签页支持状态/关键词过滤、分页、历史和 `tab=agreements&agreement=<id>` 深链接。任务头部可以直接查看约定，停留期间的变化显示“有更新”；这是当前身份/任务内存中的提示，不是持久通知、阅读回执或模型送达证明。编辑冲突保留草稿，临时读取错误不卸载编辑器，明确撤权则清理；未知回执只确认原请求。查看历史需要显式刷新。

## 权限与接口

project view 可查看；edit/manage 可发布、修改、替代、停用和启用。读取、旧回执和新写事务都复核当前项目/空间权限。发布也重新核对原任务/消息的访问范围，源消息版本变化返回 409。归档项目仍允许人工维护。

- `GET /tasks/:taskId/messages/:messageId/agreement-preview`：来源预览与指纹，无副作用。
- `GET /tasks/:taskId/agreements-notice`：当前项目有效约定数量和独立变更版本；私有任务不返回项目约定。
- `GET/POST /projects/:projectId/agreements`：分页读取或明确发布。创建字段为 title/content/sourceTaskId/sourceMessageId/expectedSourceHash，可选 replaces `{id,expectedRevision}`。
- `GET/PATCH /projects/:projectId/agreements/:id`：读取或按 expectedRevision 修改完整 title/content。
- `POST .../:id/lifecycle`：deactivate/reactivate、expectedRevision、可选 reason。不能修改已替代记录。
- `GET .../:id/revisions`：不可变历史，before/limit 分页。

列表默认 20/最多 50，状态 active/inactive/superseded/all；历史默认 10/最多 50。完整字段以 [契约](../../packages/contracts/src/project-agreements.ts) 为准。

迁移 14 添加 project_agreements、project_agreement_revisions、project_agreement_versions。现有消息/资料不会自动变成约定。约定当前记录、历史、项目版本、project outbox、幂等回执同事务；替代包含新旧两份记录。已明确发布的约定是独立项目记录，不因原作者退出或源任务后续改变而冒充被撤回。

发布和编辑约定不自动加入模型输入；Project/Task 修订、既有 Run/dispatch/Operation 和目录锁保持不变。开始或接续时可通过 [05-05/06 明确选材](project-materials.md) 固定版本，启动确认不代表模型收到。持久提醒、任务子范围约定与正式远程部署仍未交付。实际检查见 [21](../development/21-implementation-status.md)。
