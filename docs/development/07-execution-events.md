# 07｜受管执行、事件、输入与停止

> D1 · M1—M4 · 关联 HX-F04/F05/F07/F11 · 依赖：04 基础、06。  
> [计划入口](README.md) · [状态定义](../product/05-domain-and-state.md) · [协议总表](18-data-api-catalog.md)

## 1. 交付目标

一个用户动作只创建一个逻辑 Run。Run 正常结束、任务完成和节点离线彼此独立；真实输出能够在刷新后恢复。前端、执行器与两种原生工具消费统一事件，但不丢弃原生差异。

## 2. 请求进入执行的步骤

`POST /tasks/:taskId/runs` 接受 agentProfileId、nodeId、可空 workingCopyId、contextBundleId、purpose、previousRunId、expectedTaskRevision 和可选 reopenTask。服务端重新核对任务、节点、材料和工具能力，不能信任前端已经核对。

在事务中建立 Run、配置/输入快照、幂等记录和 dispatch outbox。任务待处理时由实际执行开始转为进行中；任务为 done 时必须有明确重新打开意图。Run 准备失败保留失败记录和已有任务，不标记任务完成。

worker 领取 outbox 后派发；执行器以 dispatchId 去重，返回 accepted 只代表接单，不代表进程已运行。preparing→running 必须来自实际创建或恢复的原生执行确认。

## 3. 数据模型与状态

runs、run_inputs、run_events、dispatches、native_sessions、action_authorizations、working_copy_leases。Run 固定保存工具/适配器版本、有效模型与配置、账号引用、节点、上下文、工作区、前驱执行和执行用途 main/assist/parallel/template。

生命周期沿用 queued/preparing/running/waiting_input/waiting_approval/stopping/succeeded/failed/cancelled。连接另记 fresh/stale/unknown 与 lastConfirmedAt。终态后重复消息只去重；更正需由可信对账事件明确说明，不被迟到日志任意反转。

Run 的 observation 不等于其所属节点是否在线：节点在线但原生进程无法确认，也可能需要核对。停止与自然完成竞争时保留实际结果，不把已经成功的输出清空。

## 4. 事件与 UI

归一化事件包括 run.state_changed、run.input_requested、run.authorization_requested、message.delta、message.completed、working_copy.changed、usage.reported、result.available、node.connection_changed。事件 envelope 见 18，包含 eventId、来源、序号、revision 和关联 ID。

高频文本按块处理，可将完整原始输出存文件引用；状态和授权事件不能为了限流丢弃。浏览器订阅带游标的 SSE，刷新时先读取快照再补事件，缺口过大回到快照。按订阅者权限过滤，不能把整个空间的输出推到每个客户端再靠 UI 隐藏。

前端收到 delta 只更新消息，不能从“任务完成”字符串推导 Task.done。一次会话可对应多次 Run，费用和操作者边界在新的 Run 中保留。

## 5. 输入、授权与停止

`POST /runs/:runId/inputs` 返回 delivered/queued_for_next_turn/unsupported 等真实结果；等待用户与运行中追加不同。适配器不支持时保留草稿，明确下一次使用，不能静默丢失。

动作授权绑定 run、node、workingCopy、原生请求、动作摘要、scope、expiry、policy revision 和 process generation。响应前再次核对身份与有效期，批准仅对目标请求生效。可用预设允许有限动作，减少重复询问；质量检查不属于此授权系统。

`POST /runs/:runId/stop` 返回 stopping 或已有终态。执行器上报实际停止后才能显示 cancelled；无法确认旧进程不发放同现场新写入。队列取消先撤销派发代次，让晚到命令无法再启动。

原生 server/SDK 失联时，只重试传输和安全读取；对于已创建但结果不明的工作先对账，不能为“重连成功”重复执行付费或有副作用的动作。

## 6. 六个工作项

| ID | 工作内容 | 产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-07-01 | Run schema、快照、状态 reducer 与原生会话引用 | runs/domain 及迁移 | 04、01 |
| HX-DEV-07-02 | 创建/派发、幂等、outbox、节点 ACK 与去重 | run commands、worker | 07-01、06-02 |
| HX-DEV-07-03 | 事件归一化、消息分块、持久化游标、权限 SSE | event store、stream API | 07-01、07-02 |
| HX-DEV-07-04 | 补充输入、等待回复、下一轮队列与送达状态 | run_inputs、input API | 07-03、Adapter 契约 |
| HX-DEV-07-05 | 绑定式动作授权、有限策略和真实拒绝回路 | authorization service/UI DTO | 07-02、03 权限 |
| HX-DEV-07-06 | 请求停止、队列取消、租约核对、重启对账和自然完成竞争 | stop/reconcile、活动执行视图 | 07-02—05、06-05 |

## 7. 给适配器和前端的交付

08/09 只输出此协议中已定义的状态，未知原生事件保留引用和说明。10 使用统一流与动作结果，但可以显示工具特有信息。报告“支持继续”必须说明是原生恢复还是新会话，不以旧会话可读替代恢复能力。

本包需要正常流程与错误回路的开发自检，但不要求产品用户先完成一张验证清单。没有真实工具时使用显式 mock，不能把 mock 日志算作实际执行。

## E2b2 实现子集

沿用 Run 增加 node provider。事务创建 dispatch/input/幂等/outbox；节点 accepted 落盘后确认，preparing 在一次性许可请求前落盘，running 仅实际 spawn 后上报。单个 dispatch 的 generation/序号/hash 保护 ACK 重放；重复 permit 不重新发启动许可。重启不重复 spawn，未知状态仅在确认后终结。未实现完整原生会话引用、运行中输入、完整用量、WSS 和远程调度。

## E2b3 输入子集

node 的 POST /runs/:id/inputs 返回 queued_for_next_turn + 持久化条目。只保存下一轮材料，尚不支持即时输入或澄清。选中要求与后续 Run 原子绑定，实际 spawn 后标随执行启动；不是 delivered 的提供方确认。未发许可取消才自动退回待选，启动歧义不重排。
