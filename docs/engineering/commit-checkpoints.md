# 本机不可变 Git 提交引用

本批是 **HX-DEV-12-01 的 team-local／项目任务／本人节点／单仓库切片**。记录一个已存在的不可变提交，真正核对 commit 和根 tree 对象；不是完整备份、代码包、跨电脑接手或恢复。preview、私有任务、补丁包和多仓库暂未接入。

## 使用

在任务工作区选择“代码检查点 → 记录提交检查点”，填写名称，选择本人已配对节点与目录别名，提供完整的 40 或 64 位小写 Git 提交 ID。默认不选提交；分支名、标签、短 ID 和 revision 表达式不被接受。确认范围后创建本机核对请求，不会自动读取代码，也不创建 Run。

在该节点本机的 HEXU 工程中，先按现有步骤构建，再执行面板给出的命令：

```sh
npm run runner -- checkpoint --request <request-id> --state /path/to/private-state
```

`--state` 必须是配对时使用的本人私有状态目录。CLI 用该目录的节点凭证取得这一个有界请求，显示任务、实际本机路径、提交和排除项。逐次输入 `CHECKPOINT <完整提交ID>` 才开始本次核对；不把原数量摘要配对、模型执行同意或网页勾选当作本机读取同意。不需要模型账户。

CLI 只发布完整提交 ID、根树 ID、本机仓库指纹、核对时间和工作区变更数量。文件内容、文件名、绝对路径、remote URL、Git 作者邮箱及模型凭证不进入请求记录。记录对当前任务有读取权的成员可见；节点收到的任务信息仅限本人明确创建的该请求，不是任意 Task 读取入口。

请求有效期 30 分钟，每人最多 20 个未结束请求，每任务最多 1000 条历史。网页区分等待核对、引用已记录、取消、过期和原节点授权失效。节点不必正在轮询，命令可与现有 Runner 同时使用，不停止主任务或获取其写锁。

## 记录了什么，没有记录什么

`git_commit_reference` v1 保存完整 SHA-1／SHA-256 commit 和根 tree，`verifiedObjects=commit_and_root_tree`，`availability=local_reference`。根树核对不等于验证其全部子树和文件；未检查祖先图、LFS 内容、子模块仓库或远端可获取性。

`repositoryIdentity` 是本机客户端、目录授权及 Git 元数据对象库身份的不可逆指纹，**不是 remote identity**。不会把本地引用标为远端可恢复。对象没有复制或建立保留引用，可能被后续 Git 清理；历史中的核对时间只说明当时存在，离线、对象丢失或目录变更后不宣称仍可用。

所有暂存、未提交、未跟踪与忽略内容均不包含。显示的数量来自同次有界观察，会随后变化，不能作为文件清单；过滤器等特殊配置使数量无法可靠比较时显示“不可确认”，不当作零或干净现场。当前没有保存这些可变文件，因此不需要停止活动写入来构造工作区快照。

不自动执行 commit、stash、reset、checkout、push、fetch，不恢复或复制文件，不变更 Task 状态／修订／负责人、Run、Operation、冻结材料、停止请求或未知目录占用。核对 Git 提交本身不是新的质量报告或业务审批要求。

## 本机核对与失败边界

只读取本地凭证中明确授权的目录。检查真实路径与设备／inode，验证实际 Git 目录；普通仓库或标准 linked worktree 的 common-dir 布局必须一致，不能改向另一仓库。对象库拒绝 alternates、符号链接及非普通条目；本批不支持这类特殊对象存储。

使用新建私有临时元数据目录，不把原仓库配置带入 cat-file。明确禁止可选锁、replace refs 与 lazy fetch，允许列表环境不继承用户 GIT_*；不运行 Shell、hooks、filter 或 credential helper。提交与根树分别核对原始类型、长度并重新计算 Git 对象哈希，不能用 tag 或 blob 冒充提交。支持松散与打包对象、SHA-1／SHA-256。

核对上限为对象库 50000 个条目、commit 64 KiB、根树 4 MiB；每个 Git 子命令超时 4 秒。超过边界、对象缺失、格式错误或目录变化时拒绝，保留未完成请求，不伪造检查点。Git 的对象读取语义参考 [git-cat-file 官方文档](https://git-scm.com/docs/git-cat-file)。

这些是对受信任本机 Git 的有界读取，不是操作系统沙箱，也不防御同一 OS 用户持续恶意竞态。网页不控制 executable、任意路径、命令或原生模型会话。协议凭证对应本人节点；恶意节点伪造内容不可能仅靠服务端元数据验证被排除，当前记录表示该节点的核对证据，而非第三方存储校验。

## 权限、原子性与回执

迁移 20 增加 `checkpoint_requests` 和不可变 `commit_checkpoints`，不从旧 Git 摘要补造记录。网页创建和取消使用现有 Cookie／空间／同源／Idempotency-Key；创建时检查当前 Task 编辑权、任务修订、本人同项目节点及目录别名。只有同一所有者节点能核对和发布，不借项目编辑权调用同事的节点。

发布事务重新校验当前所有者权限、同一任务／项目／空间、节点 revision、请求指纹、完整提交和目录别名。记录、请求状态和任务范围 outbox 同事务保存。一次请求只产生一个记录；相同结果可重放，不同结果不得覆盖。同一个网页请求标识也不重新创建；失败回滚全部业务写入。

在 `<state>/checkpoints` 的独立私有 SQLite 日志中，核对结果在网络发布前持久化。回执丢失后再执行原命令，确认同一请求；不重新采集已经变化的仓库，不创建第二份引用。请求已记录时只读回原 ID。未确认记录阻止另一请求占用该日志；取消／过期的同一请求确认后可清理未发布结果。节点撤销而无法再确认的本机日志保留，不能自动抹掉不确定结果或换凭证重发。

取消只终止尚未记录的请求，不删除已记录引用，也不发出进程停止。项目／空间撤权和节点撤销沿用现有永久失效规则，重新加入不恢复旧节点或旧请求；旧节点回执重放也需要当前授权。历史仍按当前任务权限保留，不因节点离线自动删除。

网页临时读故障保留输入并禁用新提交；权限拒绝清除编辑，恢复授权不自动复活原选择。关闭或刷新不持久保存未发送输入，也不撤回已发请求。原请求回执不确定时固定参数，只允许确认，不换节点或提交。

## API

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/v1/tasks/:taskId/checkpoint-options` | 当前编辑者本人同项目配对节点和目录别名 |
| POST | `/api/v1/tasks/:taskId/checkpoint-requests` | 明确创建一个本机核对请求，201 返回请求；不是检查点 |
| POST | `/api/v1/tasks/:taskId/checkpoint-requests/:requestId/cancel` | 发起者当前有编辑权时取消，body 必须为空对象 |
| GET | `/api/v1/tasks/:taskId/checkpoints?cursor=` | 当前可读者按不可变顺序查看请求和记录，每页 20 |
| POST | `/runner/v1/checkpoint-inspect` | 同一节点 Bearer 只读取指定的本人请求 |
| POST | `/runner/v1/checkpoint-publish` | 本机明确确认后发布严格有界 manifest，201 返回记录 ID |

创建体仅接受 `nodeId, workspaceId, commit, label, expectedTaskRevision, confirmReference:true`。节点发布仅接受 `requestId, requestHash, manifest, confirmPublication:true`。未知字段一律拒绝；节点通道不接受浏览器 Cookie 或用浏览器身份冒用。

## 后续范围

12-01 仍部分实现。下一切片先完成 **12-02 本机完整对象核验与明确保留**，再做受控传输和独立新目录恢复：当前仅 commit／根树引用不得直接当作完整 ready 检查点。补丁与未跟踪文件、多仓库、remote identity、保留生命周期、传输、恢复失败清理以及 Handoff 状态仍未交付。原工作项与实测统一见 [19](../development/19-work-items.md)、[21](../development/21-implementation-status.md) 和 [22](../development/22-next-delivery.md)。
