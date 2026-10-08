# 2026-10-08｜切片6：原 Task 内协作体验

## 基线与范围

独立候选从片5远端精确提交 `0d4cbf57cda04cecaf0694abbdb8cd81745724f6` / tree `f65d7a9009bcf106a3f1c6064a8cbed400c31f2f` 开始，保留普通功能及片1—5实现与记录。对应原02-05/06、10-06、11-05/06、14-02/05、15-01/02/03、16-06的有限子集；无新任务编号，未把任何完整工作项升为完成。

复用 W1 `AgentAssistanceEditor`、`AgentAssistanceThread`、`AgentConsumptionStatus`、`AssistanceThread`及原Dialog、选区/预览/采用接口；不新建组织图、shadow Task/Run、通知数据库或独立协作完成状态。

## 界面/状态/操作矩阵

| 场景 | 呈现 | 操作/恢复 |
| --- | --- | --- |
| 接收者与可用性 | 显示已获准发现的能力，含不可请求项、阻碍、所有者、到期及有限授权 | 只有当前可请求项可选；配置存在不显示在线；preview/写事务仍核版本与权限 |
| 材料与授权 | 复用固定消息摘录及项目纯文本预览 | 明确同意后分享；输入/材料不被GET/SSE自动改写 |
| 原Task过程 | 一请求一条紧凑摘要，含对象、目的、阶段及最近确认来源/时间 | 打开原抽屉；`/tasks/:id?assistance=:id`深链接，Back/Forward与关闭沿原Dialog |
| 需人处理 | 澄清/范围问题突出，其余往返折叠在请求内 | 有权发起者补充固定新输入；未授权者仅等待 |
| 返回成果 | 单列回答，保留来源、时间与输入版本 | 明确人工采用与Agent消费互不冒充 |
| 送达 | 最新通知的pending/unknown/failed/suppressed/mixed/2xx事实 | 2xx只算回调收件；旧输入观测不能提升当前输入状态，无回执时间时为未知 |
| 原工作继续 | host_reported绑定、一次claim、external_self_report后续输出分别显示 | claim无ACK保持未知，不重复启动；未来取消不等于已停止外部执行 |
| 待处理 | 原工作台入口显示最近协助中待回复/澄清项 | 基于持久Assistance按ID去重，进入同Task；不建立独立可写通知状态 |
| 草稿与错误 | 空/加载/失败/撤权/版本冲突分别处理 | 同身份空间内存保留收起草稿；硬刷新不持久化；未知写同包同键，成功ACK后只GET |
| 有限接收者 | 原请求材料/回应，不挂父Task-only观测 | 不透露Task/Project/owner上下文、callback/secret/native session |

未发送输入只能存在当前Provider内存。IdentityGate按user/space卸载时清除；权限撤销清除未发送内容。业务关闭与撤权区分：丢失decline/close成功ACK时，可恢复原请求回执，不把业务已关闭误当真实权限撤销。

## 服务与权限

新增父Task-only列表和单项只读GET，默认20/上限50分页，返回统一DTO。复用原Assistance、不可变输入、Events表和消费表，没有迁移或另一个状态真源。父Task读权及请求属于该Task优先检查；接收token不能借此升级权限。

读取过期授权在SQLite `query_only=ON` 下仍可完成，不隐式写到期状态。写授权仍由原事务检查，不相信UI的canManage或元数据。DTO不含callback地址、签名材料、凭证、原thread/session或端点地址。

最新投递观测的`confirmedAt`固定null，因为原持久表没有callback收件时间。事件创建时间不能冒充收件时间；尚未drain的pending只是最后队列观测，发送时仍核当前授权。已经发生的2xx历史不因后来撤权被抹去，也不代表现在在线。

## 实际检查

- 新增7项原createApp/BetterAuth/SQLite投影测试：真实应用路由与禁用宿主NativeRuntime、父Task与direct-ID/分页、有限接收隔离、当前输入投递、领取/ACK/取消、SQLite只读到期查询。
- 新增6项状态语义测试：2xx≠接受、旧输入送达隔离、待处理当前权限、answer/claim/自报、迟到与取消、拒绝/容量/失败。
- 受影响后端41项回归：agent-assistance contracts/store/http、agent-consumption contracts/http。
- 另94项允许范围回归通过：能力、requester、原真人/AI/采用、stdio MCP/当前调用回接、receiver、Events全链进程、remote TLS与webhook。未选取受限旧Provider或文件故障测试。
- 15组实际React editor/thread/provider检查：不可请求项与授权信息、收起和GET故障草稿、同请求原键恢复/重复、普通迟到200、权限清理、折叠往返/成果来源、补充焦点、有限无父视图及关闭后的未知decline回执。
- 6组实际React Task摘要/观测/原Dialog/location/read hook检查：深链接/Back/Forward/关闭及焦点调用、加载/空/读失败/撤权、去重、普通Task切换迟到200隔离。
- 3组实际React工作台/协助列表检查：服务端待处理过滤、跨箱去重、全部待补充深链接及空状态。
- 1条实际React Task摘要/观测/消费组件→原createApp API桥接：独立Agent请求、澄清、新输入、接受、回答、claim、ACK显示同一记录，断言1 Task/1 Assistance/0 Run。
- 原完整server/Web TypeScript、完整`npm run build`（server+原restore helper静态编译+Vite186模块）、tokens、format及diff检查通过。JS约767.10kB/gzip217.81kB，保留非阻断500kB bundle提示。

组件检查使用真实React renderer及原产品组件，网络/外围状态与DOM节点为显式测试替身；桥接使用原完整应用、BetterAuth与SQLite的假账号。没有监听真实服务、使用真实账号或模型，不把这些检查当真实浏览器/模型联调。完整构建中的helper仅编译，没有运行受限文件apply/restore场景。

## 验证限制与下一步

真实浏览器未完成：此前自行Chromium socket EPERM与预置云浏览器访问loopback ERR_BLOCKED_BY_CLIENT为已知明确拒绝，本轮均不重试，不借别名/代理/隧道/提权或真实部署绕过。布局使用现有tokens、窄屏规则和语义控件，renderer中的焦点调用不能证明真实键盘或视觉验收。

没有运行包含受限旧Provider跨身份迟到401/space403或#52 apply/restore的全套`npm check`/CI，也没有改workflow、创建PR、推main或部署。只发布独立feature候选。

本机Codex+当前dot双方经HEXU的真实接入仍需HTTPS地址、实际认证/持久权限、费用与第二真实成员条件。没有用新建替代线程、预置ID或人工搬运问答冒充原工作继续。切片7由协调者另行确认前置条件与唯一owner，本片不自动启动后续scope。

### 冷审阅后的收口

独立新上下文审阅指出：工作台若先取20条active再过滤待处理，会让更早的澄清请求被新回答淹没。改为服务端按当前权限过滤`agent_attention`后分页，再按ID去重展示；我的协助提供对应过滤与分页。只投影需要发起方补充/范围决定的记录，不把接收Agent正常等答状态转成人工逐条确认。原102行实际基线为3完成/84部分/15未实现，本片15-03子集升部分后为3/85/14；历史时期统计保留。

最终独立审阅已复核上述P2修复，未留未解决P1/P2。新增回归包括scope提案、过滤集内分页/新插入、当前权限撤销及旧cursor409、过期待补充只读查询；没有通过放宽权限或扩大接收者可见性修复提示问题。

最终源树按明确列出的20个允许测试文件重跑，共148/148通过；上述24组React组件与1条原API桥接通过。原server/Web配置、production build、tokens、format再次通过，未运行全套受限CI。
