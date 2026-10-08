# 2026-10-08｜Agent 固定回答回到原工作

## 基线与范围

独立 `codex/agent-result-resume`，基线为切片3 `f3c943d4426404ac1e13c2d20a4dd0f660db1f6f`。完整clone保留前片源码、普通候选与规划事实；未触main、其他候选、用户电脑或在途其他项目。原07/11/14条目仍为部分实现。

本片交付**当前原生调用内**的结果回接协议：MCP原host配置原thread/session，原子创建Assistance与绑定；有限有界查询、固定回答claim返回原Agent、后续输出ACK。不是控制服务启动模型，不会新建另一个Task充当继续。

- 短答案直接引用不可变Assistance response，保存response ID、input revision/hash、access revision、answer hash、来源actor及材料ID。没有第二成果表或shadow Task；未增加ResultRevision创建入口。
- 绑定只允许最初发起Agent/connection，固定原Task及origin，host_reported。原子创建修复“快速receiver先回答、后bind失败”的窗口；旧无绑定create回执不可补认。
- 一请求最多一个claim；相同/不同key重复都不能取得新执行机会。同键异包冲突，当前权限/材料先于旧回执。断线未知只核对，不能重放付费启动。
- ACK固定原thread/session和后续turn/output，明确external_self_report，不伪造provider receipt、成功assist Run或真实停止。未来回接取消与请求取消不同，迟到观测不复活绑定。
- 原Task协助详情显示待取用、已领取未确认、外部后续输出与取消观测；有限receiver不获得父投影，原生IDs不进入人工投影。
- 已认证外部answer新增明确人工采用来源分支，沿原多片段/任务说明事务。保持旧真人与Claude成功Run门槛。自动Agent使用回答不依赖人点击采用。

## 实际检查

最终新run以最终源码为准：

- 原完整 `npm run build:server` 通过（TypeScript + 原build-restore-helper静态cc编译）。未执行恢复助手或恢复/故障诊断。
- 107项后端定向测试通过：片4新增24项（18真实createApp/BetterAuth/SQLite、2DTO、4MCP）及83项相关协助/采用/身份/请求/MCP回归。假账号和独立临时数据库；没有真实模型或费用。
- 5项独立stdio进程测试通过（2新+3前片）：新链经生产桥与完整app完成澄清→回答→claim→原工作fixture后续输出→桥重启→同绑定ACK；另真实丢弃已提交claim的HTTP响应，核对保存记录且重放只得replay。1Task/1Assistance/0Run/0model；原工作host引用及后续行为为确定性fixture，不是实际Codex模型证明。
- 31项React renderer通过（7新消费状态+24相关协助/发起授权），明确read hook/外围依赖替身；不是浏览器验收。
- 原server/Web完整类型、Vite production build（181模块）、UI tokens、原format与diff-check通过。Vite保留已有非阻断大bundle提示。
- 独立审查发现并修复bearer sourceActor owner暴露、human answer冒充Agent消费、origin格式错配和create→bind竞态；最终无未决P1/P2。

首次默认npm缓存目录不存在导致安装失败；在可写临时缓存使用原锁 `npm ci --ignore-scripts` 后成功，未改锁或运行安装脚本。测试中的任务详情字段断言、旧MCP工具数量断言错误已修复并重验，不掩饰为产品故障。一次旧测试进程轮询被automatic review取消，获明确授权同参数重试后Unknown process id；旧结果未取得，不算通过或失败。上述107项是其后实质修正源码的新完整定向run，未换路线读取旧结果。

## 验收矩阵与恢复语义

| 情况 | 实际验证与限制 |
| --- | --- |
| 正确回答/来源/版本 | 严格固定response/input/access，Agent来源限定；错误请求、版本、绑定及human回答拒绝 |
| 快速答案 | 原请求与binding同事务；快速answer前绑定已存在，同键恢复不补建 |
| 重复/并发 | 唯一claim/不可变ACK、回执同包核对，不重复后续工作 |
| 撤权/新输入/源资料改变 | 消费前当前权限和固定来源复核；失效不因旧键复活 |
| 离线/重启/未知结果 | SQLite持久claim，桥/服务重启后读取原引用；无ACK仍未知，不自动新开执行 |
| 取消与迟到 | 分离取消未来回接；旧claim的可授权迟到ACK仅观测，不确认停止 |
| 线程变化 | 不可改绑；不同host thread在MCP claim前拒绝；真实native thread仍待实测 |
| 事务失败 | 仅新消费业务SQLite测试trigger中止绑定insert，原请求/授权/outbox/回执全回滚；不触文件恢复链 |
| 内容/工具安全 | 外部回答纯数据/纯文本呈现，恶意文字不新增工具或权限；无provider执行器被调用 |
| 人工采用 | 真实外部来源分支、不造Run；原Task说明仅明确采用POST变更 |

## 未验证与下一项

真实本机Codex、当前dot插件/Events、第二真实成员、真实跨环境传输与真实模型使用回答继续均未验证。当前MCP只支持当前调用内有界读取；跨回合Codex SDK/app-server恢复和后台唤起未实现。host_reported/外部自报不是独立provider证明，也不保证外部执行恰好一次。

片3receiver token仍由所有者预置单请求，不等于新请求自动bootstrap。片5承担正式远程认证、部署边界、bootstrap/事件与持久恢复；不混MCP经典stdio和MCP2 Events。真实目标需授权环境实测，不把协议fixture抬成片7里程碑。既有Chromium/socket与本地CUA访问拒绝未重试，浏览器残余仍在。未触被拒旧Provider跨身份诊断、selected apply/restore链、真实凭据或持续权限。

发布仅此独立feature，不建PR、不改workflow。当前唯一CI为main push/all PR，feature无PR不会自动触发；发布后对exacthead与改动blob回读并核对无workflow，不能用旧main失败或PR77绿色代验。
