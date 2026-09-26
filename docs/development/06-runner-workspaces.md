# 06｜本地执行器、代码现场与进程管理

> D1 · M1—M4 · 关联 HX-F01/F04/F06/F11 · 依赖：01、03。  
> [计划入口](README.md) · [执行事件](07-execution-events.md) · [接手](12-handoff-sharing.md)

## 1. 用户获得什么

开发者连接自己的电脑，继续使用本机代码、原生工具和 IDE；网页可以启动获授权的任务并查看状态。无需暴露原生控制端口到公网。个人节点默认只由本人及明确授权者使用。

## 2. 执行器组成与未来命令

建议 `apps/runner` 包含 cli、connection、processes、workspaces、storage、adapters 和 diagnostics。规划命令如 `hexu connect`、`hexu start`、`hexu status`、`hexu disconnect`，实际实现后才写进可执行安装说明。配对不把长期凭证放进命令行参数和 shell 历史。

网页申请一次性 pairing session，用户在本地显式确认服务地址、空间、身份和允许目录；执行器兑换受范围限制的节点凭证，主动 WSS 连接服务。短时配对码原子消费；设备凭证优先系统凭证存储，服务只保存验证所需信息。不能要求用户复制公司模型密钥到仓库。

## 3. 节点与连接

握手上报 nodeId、protocolVersion、runnerVersion、OS/arch、工具可用性、已授权目录和上次确认游标。系统分开保存连接状态与 Run 状态。心跳周期由配置控制；失联只改变 observation，不说明原进程已经停止。

本地持久化 spool 保存命令处理阶段、Run、PID 加启动标记、原生会话引用、事件序号和 ACK 水位。服务只在落盘后 ACK，执行器重放未确认事件。进程重启后先对账，不因服务说“运行中”就重新 spawn。

进程创建与日志落盘不能假装是单一事务：预写 preparing，spawn 后补进程身份；处于不明确窗口时保守显示需要核对，不能自动再次创建写进程。PID 可能复用，必须结合启动时间和运行标记。

## 4. WorkingCopy 与 Git

一项代码任务绑定 workingCopyId：node、canonical realpath、repository、branch、base commit、可识别改动与授权根。路径解析处理符号链接、大小写和目录别名，避免两个 ID 指向同一现场却各拿一个写权限。重叠目录应提示并协调。

可接入已有本地目录，不自动 reset/clean/stash；创建隔离工作区时使用 Git worktree 等基础机制。[Git 官方参考](20-technical-decisions-sources.md#s06)。分析或纯文本任务允许没有 WorkingCopy。

调用 Git 使用参数数组和独立 stderr，不能拼接来自任务标题的 shell 字符串。状态采集涵盖已跟踪修改、未跟踪文件、二进制和 submodule/LFS 不可用等情况；不上传 `.env`、凭证和整个 HOME。差异快照记录采集时间与版本，活动现场不冒充不可变提交。

## 5. 写入与进程控制

同一受管现场只允许一个活跃写入者；server lease、generation 与执行器本地锁共同工作。租约到期但旧进程未确认停止，不直接把同一现场交给新执行者。不同工作区仍要分配端口和临时资源，不能把 worktree 当成安全沙箱。

停止优先原生取消，随后在明确支持的 OS 中终止受管进程树。POSIX 进程组与 Windows 受管作业等实现分开，不把关闭父进程当作所有子进程已结束。不能确认时保留 unknown，给用户查看和人工处理入口。

外部 IDE 不受平台全局控制，检测到变化记录“外部修改”，不推断是谁写的。关闭网页不结束任务；退出执行器需提示活动进程，提供明确的停止或保持行为。

## 6. 六个工作项

| ID | 工作内容 | 产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-06-01 | CLI、配置、配对、凭证引用与节点注册 | runner CLI、pairing API | 01、03 |
| HX-DEV-06-02 | 主动连接、握手、心跳、ACK、spool 与断线重放 | connection/storage 模块 | 06-01、01 协议 |
| HX-DEV-06-03 | 目录授权、路径规范化、WorkingCopy 注册与 Git 状态/diff | workspace service、GitPort | 06-01 |
| HX-DEV-06-04 | 隔离工作区创建、活动写入锁、资源登记与清理保护 | worktree/lease 模块 | 06-03、07 契约 |
| HX-DEV-06-05 | 进程身份、输入输出、取消与跨 OS 进程树处理 | ProcessHost、停止结果 | 06-02、06-04 |
| HX-DEV-06-06 | 节点重启对账、断连提示、工具检测与本地诊断输出 | reconcile、diagnostics | 06-02—05 |

## 7. 不扩张的范围

本包不是远程桌面，也不是任意 shell 管理平台。文件读取、终端、预览均需具体 scope，分别在 10/14 落地。普通本地目录可先工作，容器与专用远程节点是后续执行方式，不强迫用户迁移所有代码。

打包和自动升级由 17 统一维护；01 提供初始可运行的开发启动方式，不能让实际任务一直依赖尚未交付的安装器。

## E2b1 当前实现子集

独立 CLI、一次性配对、持久化节点身份、本机目录授权、项目可见摘要、心跳/连接代次、摘要 spool/ACK 与撤销已落地。传输是仅回环 HTTP，不是规划中的远程 WSS；没有 Run 命令/进程 spool、节点任务派发或自动恢复模型工作。06-01/02/03/06 仍部分实现，06-04/05 的完整节点写入与进程链路在后续收口。见 [独立节点说明](../engineering/runner-node.md)、[逐项状态](19-work-items.md) 与 [当前工程记录](21-implementation-status.md)。
