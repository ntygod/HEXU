# 09｜Codex App Server 适配器开发

> D1 · M1—M2 · 关联 HX-F04/F05/F11 · 依赖：06、07；可与 08 并行。  
> [计划入口](README.md) · [公共契约](18-data-api-catalog.md) · [官方依据 S05](20-technical-decisions-sources.md)

## 1. 目标与边界

通过本地执行器管理 Codex App Server，而不是抓取终端的屏幕文字。优先使用本地 stdio，浏览器不直接连接原生 App Server；中央服务也不因此拥有任意本机路径权限。

原生接口事实以 2026-09-25 核对的官方文档为参考，实际代码按安装版本生成/锁定的 schema 实现。部分字段是实验能力，不默认开启整组 experimentalApi。

## 2. 初始化与请求管理

ProcessHost 启动 `codex app-server`。每条新连接执行 initialize 请求并随后发送 initialized 通知，完成后才调用业务方法。请求/响应与通知按协议分流，维护 pending request、超时、取消和进程代次。

协议是 JSON-RPC 风格的结构化消息；不要擅自假设所有消息均是普通响应，也不要给方法添加未被当前 schema 接受的字段。stderr 与 stdout 协议流分开。

初始可按执行隔离宿主进程，后续按账号配置复用连接；进程复用不能导致停止一个 Run 时杀掉其他任务。连接断开后原生工作结果可能未知，先查询/核对，不重发 turn/start 制造重复工作。

## 3. 原生对象与 HEXU 映射

| 原生概念 | HEXU 处理 |
| --- | --- |
| thread | NativeSession 引用，附 node、accountRef、原生配置范围 |
| turn | 本次受管 Run 的原生工作边界；不得用一个 thread status 覆盖全部 Run |
| item | 消息、工具调用或变更活动，保留 nativeItemId |
| thread/start、thread/resume | 新会话和恢复，结果分别展示 |
| turn/start、turn/steer | 开始执行与支持范围内的运行中追加 |
| turn/interrupt | 请求中断，不等同于已终止 |
| model/list | 读取当前可用模型/配置，分页并保存来源时间 |

这些原生方法在官方 App Server 文档中提供；HEXU 的映射规则是本计划设计。见 20 的 S05，不使用文档示例模型名作为产品默认配置。

## 4. 事件、授权与模型

将 item 消息、文本增量、工具进度、变更和 turn 结束映射到 07 的事件；保存 threadId、turnId 和 itemId，避免并发线程串流。原生终态 interrupted 映射 cancelled，真正错误映射 failed；成功结果只表示这次执行结束。

App Server 可向客户端发起请求。授权、澄清问题需要独立处理并带原生 requestId 返回，不能当作普通通知忽略。每个请求绑定 ProcessHost generation、Run 与 scope；旧进程的同数字 ID 不能被新的响应误批准。

模型选择取 model/list 的实际返回及账号配置，不硬编码某一代型号。切换模型时记录新 Run 配置；不支持中途修改时留待下一次，而不是伪装实时切换。

保持明确的 sandbox/approval 配置。不能为了消除弹窗直接设置完全访问；有限预授权与实际文件/网络隔离分别实现。只读协助的可用性由这些边界共同确定。

## 5. 恢复与故障

保存原生引用后再更新关联事件。找不到会话时允许基于已有上下文新建；身份或目录变更需要重新检查。网络重连和原生进程重启是不同情况，进程重启后重新初始化，先核对原 turn，再决定是否恢复会话。

turn/interrupt 返回响应只说明请求得到处理；继续等目标 turn/completed 或可信对账结果。未确认结束时不释放同现场新写入。未知原生事件保留安全诊断，不静默把操作判成功。

用量按实际事件与原生范围上报；缺少金额时可以显示 token 信息但费用为 unknown。不同账号和 session 的累计值不能交叉做差。

## 6. 六个工作项

| ID | 工作内容 | 交付物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-09-01 | 原生版本/schema、stdio 宿主、握手和能力声明 | CodexTransport、descriptor | 06、07 契约 |
| HX-DEV-09-02 | 请求分流、thread start/resume、turn start 及引用持久化 | CodexAdapter.start/resume | 09-01 |
| HX-DEV-09-03 | item/turn 通知与消息增量、结束、差异事件映射 | event mapper | 09-02 |
| HX-DEV-09-04 | model/list、运行中输入、服务端反向请求与权限响应 | models/input/auth bridge | 09-02、07-04/05 |
| HX-DEV-09-05 | interrupt、进程异常、连接恢复与原生状态核对 | stop/reconcile | 09-03、06-05 |
| HX-DEV-09-06 | 结果和用量归一化、资源卡片、兼容范围与故障文案 | result/usage、配置 DTO | 09-03—05、10 |

## 7. 交付边界

本包提供统一 Adapter 契约，不另建 Codex 独立任务列表。HEXU Task、Run、Result 与 Claude 接入使用同一模型；原生特有信息可在详情展开。M2 的跨工具继续由 11 实现，不在本包私自复制 Claude 会话内部状态。

## E1b 当前实现子集

Codex 已新增本机 stdio 初始化、配置检查、API-key 内存认证、thread/start、turn/start、事件、model/list 和 interrupt；原生 resume、运行中输入和完整授权问答仍未实现。官方 0.157.0 仅做无模型协议检查，完整流程用协议替身，真实账户联调未执行。

实际使用与限制见 [原生说明](../engineering/native-execution.md)，最新进度见 [21](21-implementation-status.md)。

## E2c1 当前增量

节点可选 retainSessions，保存私有原生引用并显式 thread/read → thread/resume → turn/start；同范围最新成功来源才可恢复，无失败回退。原生历史不上传，新增本机列表/清理和继承历史 UI。真实账户生成/恢复未联调；09-02/05/06 仍部分实现。见 [会话说明](../engineering/codex-sessions.md) 和 [21](21-implementation-status.md)。
