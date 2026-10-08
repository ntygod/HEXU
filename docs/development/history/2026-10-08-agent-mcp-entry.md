# 2026-10-08｜切片3：有限发起授权与MCP薄入口

基线为切片2 `7874614016057405ad3353b22a1d67c66b2ecc3e`。保留片1/2、普通候选及用户规划，独立功能分支交付；没有合并main、PR、workflow变更或部署。原首里程碑保持两个真实成员、两个独立Agent、跨环境协商并继续原工作。

## 本次可操作子集

- 新单Task/固定材料/固定目标requester预授权，独立token哈希保存、首次返回一次、最长24小时；最小UI提供预览后明确发行、查看与撤销。
- 真正Agent发起/新输入/取消来源及connection-scoped回执，沿原Assistance事务/授权/outbox；旧capability_read和接收token不升级。
- 经典stdio MCP的9项发起工具与4项有限接收工具，严格schema/版本/role、无resources、无隐藏执行。本地桥只映射现有业务。
- 未知创建结果先按原operationKey查回执；重启桥不重复写入或启动工作。接收范围仅原请求，不提供父任务或全项目通读。

## 验收矩阵与证据

| 层 | 覆盖 | 结果归属 |
| --- | --- | --- |
| 契约/协议 | 严格字段、材料子集、角色、版本握手、API不匹配、重定向拒绝、通知不写入 | agent-requester-contracts / agent-mcp-protocol |
| 完整业务HTTP | BetterAuth两可丢弃成员，完整createApp、SQLite、权限隔离、回执、真实Agent来源 | agent-requester-http |
| 真实本地协议 | 独立stdio子进程→回环完整应用，丢create响应→重启→原回执，取件/澄清/新输入/回答及撤销 | verification/agent-mcp-loop.test.mjs |
| 原功能回归 | 片1/2和普通真人/Claude/采用 | 原65项专题 |
| UI | 真React renderer、命令状态、单次secret、输入与权限边界、真实业务桥接 | requester UI定向检查；不是视觉浏览器 |
| 静态 | 原server/Web配置类型、Vite、tokens、改动格式 | 具体命令结果见下 |

实际检查结果见下方收口检查；协议单项替身与真实stdio/HTTP链分别记录。

## 明确未验与后续依赖

本片接收请求token由fixture中的所有者预置。之后多轮问答不搬运，但**新请求的token引导尚非自动化**。切片5须在最初有限预授权后完成受限安全取件/投递，不能用项目万能token补洞。

协议测试的两端是明确的无模型客户端程序，不是用户本机Codex与当前dot；内存BetterAuth账号也不是两个真实用户。0模型调用、0 Run，没有原生thread消费/恢复，没有云端远程通信，没有dot插件或Events订阅，首个产品里程碑未完成。

官方前置核对：经典stdio协议 `2025-11-25` 和dot Events当前所需MCP2.0 `2026-07-28`不同；后者要求 `server/discover` 与 events 方法、持久订阅、签名HTTPS回调。Codex SDK原threadId继续能力的官方存在不等于HEXU已接入。[工程说明与官方来源](../../engineering/agent-mcp.md#与所选真实两端的差距)。

此前真实浏览器两条路线明确受限，本片未重试或绕过，UI视觉验收仍空缺。未运行被暂停的Provider跨身份诊断、#52文件apply恢复/安全复核，也未运行包含它们的整套check/CI。`npm run build:server`在此恢复快照上执行tsc后因缺少`build-restore-helper.mjs`失败；使用原`tsconfig.server.json`完整编译单独通过，未改脚本绕过或宣称完整build:server通过。

新独立分支不满足原CI的main push/PR触发条件；发布后按exact head核对，不借旧CI绿色结果。没有例行ZIP，交付代码提交和路径。

## 收口检查（2026-10-08）

- 原 `tsconfig.server.json` 完整服务端TypeScript编译通过，包含新增MCP应用和原control/runner/adapter/tests；不是替代配置或抽取业务stub。
- 新后端/协议21项：3 requester契约、9真实身份完整应用HTTP、6 MCP协议/传输单项、3独立stdio进程→真实HTTP完整业务闭环。协议单项中的传输错误模拟单列，不代替真实应用闭环。
- 丢create响应的回环夹具只向该测试的真实临时控制服务转发并断掉一次提交响应，不是浏览器访问绕行；重启后同operationKey恢复相同requestId/AssistanceId/inputHash/材料。读回执无额外outbox，重复accept/answer无额外回应/outbox，重复create无额外请求/outbox。显式预置合法receiver token后所有中间往返经工具进行，0 Run/0模型。
- 新UI15项：13真实React renderer、2 React→共享client→原createApp/BetterAuth/SQLite桥接；发行/revoke和发行响应丢失原键核对只产生一个凭据，不创建Assistance或Run。
- 原片1/2与普通相邻回归65项通过（原47协助/真人/Claude/采用+18能力）。保留早前验证边界；没有运行原生执行器或被暂停诊断套件。
- 原Web TypeScript、tokens和Vite production build通过，180模块；保留非阻断bundle>500kB提示及React renderer弃用提示。真实浏览器未验。
- 独立审查发现经典MCP `tools/call.arguments`可省略的兼容P2；已修为缺省空对象，显式非对象仍拒绝，并新增无参工具成功/必填工具失败回归。独立审查与fresh-dist混合入口probe最终确认无未解决P1/P2。

测试夹具修正与生产合同分开：owner发行路由明确201，不能断言200；Fastify.inject不接受值为undefined的header，改为真正省略；receiver发行会按已有事务推进Assistance修订，取消前须重读当前修订；本地跨请求拒绝属于rejected而非unknown。没有为测试改状态机或放宽权限断言。

独立审查另定位MCP删减选材→human补充及不同顺序凭据之间的materialId错配P2。新preview统一稳定opaque source摘要标识；旧快照不改写，历史校验沿保存IDs，新requester对不兼容旧别名fail-closed。补跨入口/多凭据同源回归，非通过放松权限或状态断言修绿。协议工具输入校验改`isError:true`，封包错误/未知工具仍JSON-RPC错误；stdio文档使用`node`或`npm run --silent mcp`避免npm横幅污染。

UI/app整合复验37项通过（新UI15、旧协商renderer/真实桥13、原真实app/identity9）。首次整合命令因漏设fixture依赖工具环境而报esbuild缺失；使用明确`HEXU_UI_TEST_TOOLS`后通过。fixture工具依赖为esbuild0.25.10、React/react-test-renderer19.2.0，未改变应用锁文件；不是浏览器验收。

稳定ID追加实证：完整HTTP验证同源在[A,B]、[B]、[B,A]和新source版本保持相同ID，源版本变化仍409；独立stdio链验证MCP仅B→真人澄清→另一B-only凭据继续→receiver回答，输入来源agent/human/agent。另插入合法旧格式fixture保留immutable触发器，旧输入字节未改，human sourceChanged=false、旧receiver可回答；新requester get403/list过滤。单进程工具限流第121次不发HTTP，下个时间窗恢复，未建立业务状态。
