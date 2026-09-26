# ADR-0007｜独立节点的本人执行与一次性启动许可

日期：2026-09-26（UTC+8）。对应 07-01/02/03/06，联动 06-04/05/06。

## 决策

配对元数据与代码执行是两个能力通道。节点在本机明确确认 policy 后发布，网页只选已授权子集。首个执行切片仅允许节点所有者创建 Run，项目编辑者可停止既有执行；完整委托 AccessGrant 后续实现。控制服务不能代节点拥有者设置可执行路径或持有模型 Key。

沿用原 Task/Run，新 provider=node 和固定 dispatch 输入快照；Run/dispatch/幂等/outbox 在 SQLite 单事务。独立节点使用持久日志，在落盘 accepted 后才 ACK。preparing 在许可请求前落盘；一次性 permit 在服务事务中消费，再从实际 spawn 回调写 running。这不是 exactly-once 外部副作用承诺：许可回应或 spawn 边界失联一律保守核对，不重跑。

本地占用表独立于任何节点状态目录，保护同一用户下 preview 与各节点重叠现场。关闭数据库不会删除占用。只有确认终态或明确人工确认旧进程后删除；不以心跳、PID 数字或服务重启推断终止。

事件先落盘，按 dispatch/generation/sequence/hash 精确重放；服务存储后 ACK。取消后/终态后迟到事件只能排空序号，不反转状态。撤权后仅允许旧派发结算，不接受新内容共享。已失去任务权限的浏览器不能通过旧幂等响应越权获取内容。

## 使用既有适配器

Claude JSONL 与 Codex App Server 受限策略、进程组停止及完成事件判断复用；对 ProcessHost 增加真实 spawn 回调，不能在创建命令对象时假装 running。停止请求与终态分开。任务完成仍无需报告。

参考 Node.js 官方 child_process 文档的 detached/进程组和 spawn 生命周期： https://nodejs.org/docs/latest-v24.x/api/child_process.html 。本机日志与 OS spawn 不能是同一事务，使用单次许可、持久占用与保守恢复覆盖不明确窗口，而非重试 spawn。

## 阶段限制

传输仍为同机回环 HTTP，不是最终 WSS；SQLite 非正式存储。当前一节点一执行、一工具策略、本人派发；没有跨机器、委托成员、原生恢复、完整事件/费用、OS 沙箱、Windows、生产凭证管理。真实模型调用未联调。工程与浏览器结果只在实际运行后记录于 21。
