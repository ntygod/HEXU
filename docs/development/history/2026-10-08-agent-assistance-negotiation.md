# 切片2：有限材料、请求与双向协商候选

2026-10-08。基线37d6095；本地候选记录，分组定向/静态检查与审查已收口，尚未发布或宣布真实浏览器/双Agent里程碑完成。

## 范围与原有事实

用户已明确继续实现切片2，原先“片2仅设计”的结论属于前一时点。普通候选、片1、旧迁移1—36及已有验收记录保留；仅追加迁移37与原Assistance agent分支。不修改25的原规划，不创建另一套Task/Run/Operation或状态总账。

已读实际contracts/domain/db/control/identity、schema37及相关测试；旧设计是参考，已按代码纠正三点：本轮开放单请求有限Agent凭据而不升级capability_read；正常补充保留有效request token但逐input授权；scope提案保留主消息摘录，仅可删额外文本。

## 当前候选业务边界

- 原Assistance维持open/responded/closed/cancelled；协商阶段由当前input与回应推导。回应是accept、decline、request_input、propose_scope、answer，actor由服务端认证及policy规则产生，不接受正文冒认。
- 输入为一条固定既有消息摘录及显式项目纯文本source，输入版本不可变，回答关联原inputRevision/inputHash。项目材料改版会阻断新accept/answer，但当前权限有效时允许decline或request_input要求更新。
- scope提案只能缩减额外文本，必须保留主摘录锚点；重述问题需发起者明确确认新输入，不会自动扩大授权。
- 自动接受是policy业务事实，按固定grant占容量；等待补充保留当前接受占位，补充先释放再竞争，结束/回答/拒绝/撤权释放。不表示已送达，不拨号，不运行模型，不计作全端点执行并发控制。
- 事务内先核当前权限，再查ID-only旧回执；输入、input grant、回应、接受容量、事件、outbox与幂等原子提交。当前撤权优先于旧键查询，异包同键拒绝。
- 请求token限单request、最多24小时，仅material_read或material_read+respond，hash-only且首次响应一次明文。capability_read、Cookie与浏览器/节点身份不能互换；最小投影不含父Task/Project/源IDs。正常补充可复用有效token，但每次校验逐input grant，旧input回应失效；轮换/撤权旧代永久终止。
- 旧真人和Claude文本assist/成功Run采用边界保留，新Agent分支不能伪装走旧reply或adoption。仍callable=false、0 Run/0模型；MCP桥、真实收件、events投递、结果自动消费及跨成员/跨环境真实闭环均未完成。

## 实现入口

[contracts](../../../packages/contracts/src/agent-assistance.ts)、[domain](../../../packages/domain/src/agent-assistance.ts)、[Store增量](../../../packages/db/src/agent-assistance.ts)、[HTTP](../../../apps/control/src/agent-assistance.ts)、[独立请求认证](../../../packages/identity/src/agent-assistance-connections.ts)与schema37。

## 最终本地检查与边界

- 后端47/47：8契约/领域、12真实SQLite Store、1真实BetterAuth/createApp HTTP、26旧真人/Claude/采用回归。Store含两真实SQLite连接/Worker争最后一个per-grant容量、多表故障注入全回滚、纯文本source固定版本、永久撤权，以及stale只阻accept/answer而允许当前权限内decline/澄清。
- renderer11/11：实际UI/client/hooks，使用明确上下文/运输/UI primitives替身；检查双击、原包/原键、输入冲突对照、scope锚点、撤权清理、一次secret、轮换后的旧GET及关闭抽屉ACK恢复，不是真实DOM或浏览器。
- 真实业务桥接2/2：实际组件→共享client→原createApp/Fastify.inject→BetterAuth/SQLite；业务、路由、授权使用生产实现，运输/context/UI primitives为夹具。涵盖提交响应丢失恢复、澄清/新input/回答、凭据撤销与scope提案明确确认。不监听真实网络，不以两个假账号等同外部双Agent。
- 原server `tsc -p tsconfig.server.json`、原Web `tsc -p apps/web/tsconfig.json --noEmit`、Vite与UI tokens最终统一通过。Vite178模块，JS 740.92 kB、gzip209.89 kB；大于500 kB bundle提示非阻断。
- 片1回归独立通过：agent-capabilities18/18；真实app7子+1父=8，identity1（运行器合9）。唯一旧测试失败来自硬编码最新迁移终号/数量36；改为前36连续且所有版本唯一后重验18通过，保留历史保障，没有为了测试修改生产代码。
- 原迁移1—36逐字节不变，原schema文件SHA256 `d8c2fab9fd145212b7f24eadb9989dad3241a10c857b881ec468b6f89d5814c6`；保留其迁移数组内容，仅在数组结尾前追加37。

独立审阅过程中修正INSERT列值不匹配、closed后显式cancel、外部与不存在请求ID的opaque404差异、轮换secret被旧GET清空及类型null；stale输入业务拒绝/要求更新等回归已通过。最终代码与审查无未闭P1/P2。

以上检查分别保留含义，不相加宣称完整CI或浏览器验收。没有真实浏览器、外部Agent、模型或外部投递；片1loopback被ERR_BLOCKED_BY_CLIENT拒绝后未恢复绕行，未开展受禁身份诊断或文件操作审阅。旧普通候选及片1检查不能代替本片新增行为，本片也不倒写旧记录。

冻结后端明细见[47项范围记录](../../../verification/agent-assistance-backend-verification.md)与[原始摘要](../../../verification/agent-assistance-backend-results.txt)。其中保留迁移36旧硬编码的首次失败原因，并已补记最终18/18复验，不表示仍有失败。

### 复现入口

在已按原锁文件准备依赖的Node24环境，从仓库根运行：

```sh
node_modules/.bin/tsc -p tsconfig.server.json
node --test dist/tests/agent-assistance-contracts.test.js dist/tests/agent-assistance-store.test.js dist/tests/agent-assistance-http.test.js dist/tests/assistance.test.js dist/tests/ai-assistance.test.js dist/tests/assistance-adoption.test.js
```

React工具沿片1说明使用官方registry、固定React/react-test-renderer19.2.0及esbuild0.25.10、`--ignore-scripts`准备临时工具包；`HEXU_UI_TEST_TOOLS`指向其package.json绝对路径，不依赖机器临时路径。server先编译，再分别运行：

```sh
HEXU_UI_TEST_TOOLS="$tools_dir/package.json" node --test verification/agent-negotiation-ui.test.mjs
HEXU_UI_TEST_TOOLS="$tools_dir/package.json" node --test verification/agent-negotiation-ui-bridge.test.mjs
```

## 状态与下一项

原16-05已有请求持久关联、事务幂等、ID-only回执/outbox及实际SQLite/HTTP证据，由未实现升部分实现；Webhook、远端投递与可选自动完成仍未实现。其余原项保留状态并追加依据/剩余，当前102项为3完成/83部分/16未实现，没有整项新增完成。

本轮本地可验证交付收口后，唯一下一代码项是切片3的HEXU MCP薄入口与有限接收适配，具体范围以[22](../22-next-delivery.md)为准。片1/2真实浏览器残余保留，不被进入下一切片抹去；尚未实现原生自动收件、结果消费或首个真实跨成员里程碑。
