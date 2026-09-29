# 接手目录进入实际研发

适用：同服务、同项目、同机 Linux 的已成功接受记录。先完成[接受接手](handoff-acceptance.md)。此步骤把原接收副本准备为有限 Git 现场，再用本人身份独立配对、授权工具，在同一 Task 创建新 Run。

## 1. 准备原接手目录

在任务「接手邀请 → 查看接手处理 → 准备接手现场研发」查看命令。在原接收节点运行：

```bash
npm run runner:handoff-workspace -- --operation OPERATION_ID --state /path/to/receiver-state --target /path/to/restored-directory
```

必须是当前操作者最近成功接受的记录，使用原节点身份、原恢复目录及仍有授权的接收副本。终端列出目标、原提交、单提交历史范围与文件数；输入 `GIT OPERATION_ID` 才开始写入。确认后再次核对双方权限、任务写入、完整对象、文件字节/模式与目录身份。不同目录、用户改动、链接、已有 `.git` 或未知模型占用都会阻止准备，不覆盖用户文件。

准备只新增私有 `.git`：原提交对象、trees/blobs、Git v2 索引、`work` 分支和明确的 shallow 边界。支持 SHA-1/SHA-256；保留原 commit ID，不复制原仓库配置、hooks、remotes、账号或会话，不启动 Git 子进程、脚本、过滤器、网络或模型。索引格式和浅历史语义分别依据 [Git index-format](https://git-scm.com/docs/index-format)、[Git shallow](https://git-scm.com/docs/shallow)。

这是一个可以读取状态和继续修改的单提交浅仓库，不含祖先历史、其他分支、未提交内容、LFS 实体或子模块仓库；当前有界材料规则保持不变。准备不会自动生成提交、整合到原仓库或推送。

## 2. 配对独立节点并授权工具

成功返回 `lastRecorded.state=ready`，同时给出私有 `configPath` 和 `nodeState`，以及已正确引用路径的 `connect` 命令。配对配置包含此接手本人、原空间/项目的 `expectedScope`。将原任务生成的本人配对码粘贴到该命令；终端核对范围后输入 `CONNECT`。其他账号或项目的配对码会被拒绝。较旧服务未返回 owner ID 时也不能绕过此核对。

独立节点复用[现有配对](runner-node.md)，原节点目录列表、凭证、接收材料和原生会话绑定保持不变。新增节点占用正常节点配额，撤销沿用现有节点规则。配对码只返回一次，仅保存在当前网页内存；关闭或降权会清除显示，丢失回复只能对账原请求，不能重新取回代码。可明确取消后重新生成。

配对本身只共享目录摘要。为新 `nodeState` 编写[执行配置](runner-execution.md)，目录别名使用 `接手代码`，明确自己的工具路径、模式及预算，然后分别执行：

```bash
npm run runner -- enable-execution --state /path/from/nodeState --config /path/to/execution.json
npm run runner -- start --state /path/from/nodeState
```

`enable-execution` 仍需终端 `EXECUTE` 同意；密钥由本人本机环境提供，不写入配置或上传。准备、配对、启用执行和实际启动是独立步骤；任何失败都不自动重放模型调用。

## 3. 在同一任务创建新 Run

指引中的「查看节点并准备新 Run」打开原有执行面板。选择 `接手现场 OPERATION_ID前八位` 和 `接手代码`，核对当前可用性、工具、目录与本次材料，另行确认执行。使用接收者自己的新会话，不恢复发送者的原生历史。

真实 Node/Run/dispatch/ACK/一次性许可/工作区锁规则不变。页面只显示当前授权下的节点状态，配对 ACK 不证明模型启动；Run 终态不自动完成 Task。指引也不伪装为 Git 准备的服务端回执，准备历史仍由下面的本机状态读取，刷新后需重新打开指引；节点与执行历史由原持久 API 读取。

## 部分失败与本机记录

```bash
npm run runner:handoff-workspace-status -- --operation OPERATION_ID --state /path/to/receiver-state
npm run runner:handoff-workspace-cleanup -- --operation OPERATION_ID --state /path/to/receiver-state
```

本机日志先保存意图，再逐项保存元数据归属。`preparing` 是最后记录，纯状态读取不会推断旧进程已结束；重新取得独占日志锁后，未完成准备转为 `needs_attention`，不续写。状态输出的 `currentFilesVerified=false`、`modelExecutionAuthorized=false` 表示这条状态查询没有执行实时核验或授予模型权限。

重复准备只返回原记录，不覆盖后续修改。`needs_attention` 需明确 `CLEAN_GIT PREPARATION_ID`：先检查完整归属，再只删除本次未完成 `.git`。用户新增/修改、目录替换、缺少归属证据时保留所有现场；`ready` 仓库永不由该命令删除。成功清理后可再次逐次 `GIT` 同意，旧尝试仍留在日志。

未知模型锁不能被恢复或清理；只在独占准备日志下处理自己的 `handoff-git:` 预约，不向旧 PID 发信号。未处置准备阻止原节点删除凭证或重新配对。准备状态、配对状态和 Run 分属各自持久记录，不宣称它们构成分布式原子事务或 OS 沙箱。

当前路径尚无完整 Git 图、跨电脑部署、Windows/macOS 执行或自动恢复编排。验证使用虚构凭证和显式协议替身；真实 Claude/Codex 账户互操作仍另行验证。最近结果见 [21](../development/21-implementation-status.md)。
