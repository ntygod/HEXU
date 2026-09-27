# 有限材料的真人协助

当前切片：`HX-DEV-11-03/04/05/06` 的本机真人流程。仍是 team-local 同机回环，不代表跨电脑、访客链接或 AI assist Run 已交付。

## 使用

在任务的一条人工讨论或 AI 回复下点击“请同事协助”。填写问题，在只读消息中选择一段文字，点击“使用所选片段”，选择当前空间的一位其他成员，再核对分享预览并发送。不要求对方加入项目，也不需要模型账户或连接执行节点。默认没有选区，不自动带入整条消息。

接收者从工作台“同事协助 → 打开我的协助”进入收到的请求；发起者可在“我发起的协助”或原任务“协助记录”中继续讨论。独立链接 `/assistances/:id` 只作定位，双方必须登录并选择对应空间；链接本身不授予访问权。个人空间没有其他成员，不能假造同事或自动跨空间分享。

仅分享当前问题、所选原文、来源作者/时间与后续协助回复。预览明确说明接收者和原任务有访问权的成员可以阅读。私有任务也可在同空间明确分享片段；不会公开任务标题、说明、其他消息、项目资料、代码路径或私有原生历史。没有 Task 权限的接收者得到的详情不含任务/项目/来源消息 ID，也不含后来的来源变化信息；仍不能调用 Task/Project/Run API。

最多预览消息前 12000 字符；分享其中一段最多 6000 字符。问题最多 2000 字符，回复最多 6000 字符，每项最多 200 条回复，每人每空间最多 50 项未结束协助。字符限制不是模型 token 或费用预算。文本按原文安全显示，不抓取链接、不执行 HTML；选区沿用既有文字簇键盘处理及 LF 到原始 CRLF/CR 偏移映射。

## 状态和权限

`open` 等待同事回复；接收者回复进入 `responded`，发起者继续追问进入 `open`。两者不是 Task 的业务状态。普通项目可见成员能读协助，但不能代替双方回复；只有发起者有当前任务编辑权时，才能追问、结束或撤销。

“结束协助”停止新回复，保留接收者查看既有片段/回复的权限。“撤销分享”将协助置为 `cancelled` 并永久撤销该接收者的有限授权；原任务按当前权限保留历史。关闭抽屉不取消已发送请求；撤销不承诺收回对方已看过、复制或下载的内容。不支持重开或自动换接收者，新的分享需重新明确创建。

双方退出/被移出空间，或发起者的来源项目访问被撤销，都会在成员变更同一事务撤销原授权。若接收者已有该项目权限并被移除，也撤销对应旧协助。重新加入不复活旧链接。发起者降为只读保留阅读，但清除未发送编辑并禁止继续回复/管理。每次读取、写入和旧回执都重查当前账号、空间、源任务权限与有限授权。

## 数据与事务

迁移 17 增加 `assistances`、`assistance_grants`、`assistance_replies`、`assistance_events` 与 outbox 的 `assistance_id`。不从旧消息或成员关系补造分享同意。授权固定为 `snapshot_reply`，绑定接收者与快照哈希，不能提升为 Task/Project/目录授权。

创建同时保存协助、固定片段/来源指纹、授权、事件与幂等回执。回复与状态变化使用独立协助 revision；并发陈旧版本返回 409，回复和 revision/事件/回执同事务。回执只存记录 ID，每次重放返回当前有权限的投影，不能返还陈旧 Task 链接或反转后来的取消。源内容、负责人、参与关系、Task revision、Run/派发/Operation、已有材料和未知目录占用均不被协助操作更改。

事件仅含协助 ID、种类、时间和空间，不带 Task/Project ID 或正文，按当前读取权限过滤。独立详情每两秒重新读取，列表每五秒更新；已撤销对象不继续推送。正常读取故障保留未发送输入并禁用写入；确认 401/403/404 后清除内容与编辑。页面/空间/身份切换与关闭不持久保存未发送内容。历史翻页与用户阅读不自动滚动，持久通知/阅读回执未交付。

## API

所有写请求沿用同源、身份、`X-Hexu-Client` 与 `Idempotency-Key`；浏览器使用当前 `X-Hexu-Space`，不接受节点 Bearer 代用。

| 方法与路径 | 语义 |
| --- | --- |
| `GET /tasks/:taskId/messages/:messageId/assistance-preview` | 当前来源/任务版本与只读原文预览，需任务编辑权 |
| `GET /tasks/:taskId/assistance-recipients?q=&cursor=&limit=` | 同空间其他真人，不列邮箱或其他空间成员 |
| `POST /tasks/:taskId/assistances` | 明确创建，返回 201+当前详情 |
| `GET /tasks/:taskId/assistances?state=all` | 当前任务可读协助 |
| `GET /assistances?box=received\|sent&state=active\|all&cursor=&limit=` | 当前主体的收件/发件列表 |
| `GET /assistances/:id?before=&limit=` | 有限详情及按 revision 翻页的回复 |
| `POST /assistances/:id/replies` | 双方回复，返回 201+当前详情 |
| `POST /assistances/:id/state` | 发起者明确结束/撤销 |

创建体：`{sourceMessageId,expectedSourceHash,expectedTaskRevision,range:{start,end},recipientId,question,shareConfirmed:true}`。范围指原始保存文本的 UTF-16 偏移，服务端自行切片并拒绝越界、拆开字符或超预算；不相信客户端提供的原文/权限/作者。回复体：`{expectedRevision,body}`。状态体：`{expectedRevision,action:'close'|'cancel'}`。未知字段被拒绝。

## 剩余范围

当前只有一条已有消息的单个固定摘录与真人文本回复。文件/diff/成果选材、AI assist Run、隔离工作区、建议局部采用、跨空间/跨电脑协助、邮件/持久通知、阅读回执与重新分享仍单独待交付。测试使用虚构账号与数据，不发起真实模型调用。实际工程平台和结果见 [21](../development/21-implementation-status.md)，下一项见 [22](../development/22-next-delivery.md)。
