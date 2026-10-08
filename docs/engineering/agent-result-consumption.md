# Agent 回答回到原工作

本片提供经典 stdio MCP 的**当前原生调用内回接**：发起 Agent 在原工作中等待/查询已保存回答，领取固定回答作为数据，继续原工作，再报告可观察后续输出。人不需搬运回答或点击 ACK。控制服务不启动模型，也不替外部 Agent 新开任务。

## 原工作绑定

接入宿主须从自己的实际原工作取得 `thread.id`、`thread.sessionId`，配置 `HEXU_ORIGIN_PROVIDER=codex`（其他实现为 `external`）、`HEXU_ORIGIN_THREAD`、`HEXU_ORIGIN_SESSION`，连同既有有限 requester 凭据启动 MCP。ID 只接受不透明有限标识，不接受路径/URL。工具参数不能指定或替换宿主绑定。

这是 `host_reported` 来源，HEXU 认证的是参与身份及连接，尚未独立验证实际 Codex 会话。不能随意填写另一个任务 ID 当作继续证明。配置了 origin 的 `hexu_create_request` 原子保存 Assistance 与原工作绑定；原 Task 从有限凭据取得，调用者不能替换。无 origin 的旧发起方式仍兼容，但不能声称具备结果回接。

旧请求可在回答前 `hexu_bind_original_work`；必须是最初创建该请求的同一 Agent/连接。已有绑定不可改，换凭据、换线程或在回答后补认来源均拒绝。主路径使用原子创建，消除了快速回答抢在绑定前的窗口。

## 当前调用内的工具顺序

1. 创建请求后，按既有工具处理澄清；`hexu_wait_answer` 只读查询，`waitMs` 为 0—30000，每秒最多一次，最多30次。0为一次观察；单次HTTP最多10秒，正常等待受剩余期限限制。
2. 得到 `answered` 后，`hexu_consume_answer` 指明 `bindingId`、`responseId`、`inputRevision`、`inputHash`、`accessRevision` 与固定 `operationKey`。服务在事务及旧回执前核对当前权限、材料、原请求和答案。仅匹配已认证接收 Agent 的 answer 可领取。
3. 仅 `delivery=first` 是一次新领取。返回固定文本、原回答ID/输入版本/材料IDs与来源；全部作为不可信参考数据。它不授权工具、文件写入、共享约定或模型费用，也不改变原有用户目标与权限。
4. Agent 在同一原工作中使用回答产生可检查输出后，调用 `hexu_ack_consumption`，附独立 `turnRef` 和最多6000字符后续输出。thread/session由宿主配置注入。ACK明确标为 `external_self_report`，不是provider receipt或成功Run。

## 未知、离线与取消

一个请求最多一条消费关联，不另建成果/Task/Run。短回答复用不可变 Assistance response；本片不增加 ResultRevision 创建入口。需要独立长期成果版本时，仍用原 ResultRevision 体系，不能把当前Result数字修订猜成固定版本。

- 领取响应丢失：`hexu_get_consumption` 核对原记录；重复领取永远 `replay`，不得再次启动/继续工作。服务只能保证一次领取提交，不能保证外部模型恰好执行一次。
- 已领取但没有ACK：显示“后续使用尚未确认”，可能未运行、正在运行或已完成；不能推断失败并重放。离线保留该状态，桥重启只核对。
- ACK响应丢失：先GET，若需重发只用原ACK正文和键；不重新生成后续工作。已有ACK不可改写。
- `hexu_cancel_consumption` 只关闭未来回接；原请求取消分享另走 `hexu_cancel`。都不表示外部执行已停止。已有领取的迟到ACK在仍有当前权限时保存为迟到/取消观测，不重新开放回接。身份/来源已失效则拒绝，保留原Task历史供有权成员查看。
- 取消与已交给外部Agent的数据存在不可消除的边界：不能收回已返回文本，不能声称控制不可控外部执行。

## 人的工作台与明确采用

原协助详情显示绑定等待、已领取未确认、外部后续输出、取消后迟到观测。仅有父Task访问权才能读取；不公开native thread/session或凭据。限请求接收者看不到该投影。

已认证外部答案可通过既有多片段采用界面，明确写入原Task说明；固定真实response/input/actor来源，与任务说明/采用历史/outbox/回执同事务。保持原真人、成功且终止确认的Claude assist Run采用条件。Agent使用回答不需要先点采用，也不自动发布项目约定、完成Task或改变负责人。

## 已核对的提供方路径与未交付边界

2026-10-08官方资料：

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)：同一个thread对象继续run；恢复已有thread需明确ID。
- [App Server](https://learn.chatgpt.com/docs/app-server)：已有thread用thread/resume，再turn/start；thread.sessionId读实际值，不从thread.id推导。thread/fork生成新thread，不能冒充原工作继续。
- [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)：可指定既有session恢复，但本片未调用真实命令或账户。

当前未接实际Codex模型、用户电脑、dot插件/Events，未启用跨回合唤起或SDK/app-server恢复。无模型进程夹具证明同一原工作引用及一次消费/ACK协议，不证明真实模型已经使用回答。经典stdio不是MCP2 Events；新请求自动bootstrap、远程身份/投递和持久唤起属于片5，真实两成员/跨环境闭环仍需片7。

片7的[原线程证据规则](agent-real-integration.md#original-thread-evidence)进一步区分当前用户已有桌面聊天与另建SDK测试会话。exact thread与session必须从获准宿主接口实际读取并在求助前绑定，再用真实tool/item/turn及产物核对；环境变量、session相同、claim或ACK单独均不能证明原工作继续。现有代码没有自动取得桌面原聊天ID的适配，不假定SDK能访问它。
