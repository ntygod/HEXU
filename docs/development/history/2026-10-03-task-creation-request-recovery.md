# 2026-10-03｜普通 Task 创建的原请求恢复

## 独立范围与冻结父树

本轮只补普通 Task 创建在未知写入结果与成功 ACK 后读取故障时的恢复，属于 HX-DEV-04-01/03 的已有行为可靠性。首次提交仍使用现有普通创建 POST，创建不启动 Run；不新增字段、后端、schema/迁移、幂等协议或第二套任务模型。

父 [PR57](https://github.com/ntygod/HEXU/pull/57) 冻结 head 为 `0947dd5b238aab88947caebfe9d979005040c0e3`，tree 为 `49c2d825b78b208c0c794c132e21c3302707bf04`。其 [CI185 / 37101126911](https://github.com/ntygod/HEXU/actions/runs/37101126911) 工程/浏览器/汇总均 success，用户交接工程 622/622、独立日志复核浏览器 199/199（17.4m）和精确 head 8 张原图已验收，详见[父记录](2026-10-02-direct-task-status-recovery.md#2026-10-03-精确-head-验收完成)。这些通过只属于冻结父树，不能当作本轮新代码的通过结论。

main `a3ae2e8`、PR56 `a06998ab9035bb3164a271d77ec884204febfaad`、PR57 与旧草稿均保持冻结、未合并，不部署。用户的[锁竞争修复记录](2026-10-03-pr57-quiescence-lock.md)保持原样。本轮不读取或修改原生/文件/私有材料/registry 实现，也不恢复[问题52](https://github.com/ntygod/HEXU/issues/52)审阅。

## 冻结基线的实际复现

2026-10-03 06:35 UTC，使用冻结父树未改写的 `NewTask` 提交 closure，经 TypeScript AST 提取，结合实际 `packages/client` 请求、真实回环 Fastify HTTP 与每场景独立磁盘 SQLite Store，完成 **4 场景基线诊断**。注入边界是未发出请求、实际 201 提交后的回包丢失，以及有效 201 后 Workbench 实际 HTTP 503；没有 React 挂载、浏览器事件或像素验收，也不证明路由/权限/身份并发语义。

| 故障/后续动作 | 原表单实际结果 | 原请求回放对照 |
| --- | --- | --- |
| POST 未达服务，再次提交 | 首次 Task/计数器/outbox/receipt 均无增长；重提换键后各增加 1 | 成功请求原键/正文重放返回同 Task，无额外持久效果 |
| POST 已提交，201 回包丢失，再次提交 | 后续重提换键，Task/计数器/outbox/receipt 累计各增加 2，实际是两个 Task | 首次原键/正文返回首个 Task，所有持久表快照不变 |
| 有效 201 ACK 后 Workbench GET 返回 503，再次提交 | 表单丢失 accepted 状态；重提换键，Task/计数器/outbox/receipt 累计各增加 2 | 首次原键/正文返回首个 Task，所有持久表快照不变 |
| 已提交回包丢失后修改标题、说明和项目，再次提交 | 新正文/新键在另一个项目新增第二个 Task，未确认原创建结果 | 原键/原正文无额外效果；原键/后来正文返回 409 `IDEMPOTENCY_CONFLICT` |

诊断确认的是既有 UI 每次重提换键，以及有效 ACK 在 GET 失败后未保留的缺口；旧普通创建幂等回放本身返回原 Task，不重复追加业务效果。这与直接状态原路径遇到旧修订 409 的事实不同，不能把两类诊断混为同一结果，也不归因为 PR57 移植回归。

来源 `apps/web/src/forms.tsx` SHA256 为 `48722c6e10929224d2bc90e4e8b4691ccf5c374e94c8019f58e84701157d9d2d`；原 `NewTask` 块 SHA256 为 `f320c936cb4f2c0b6108ff005a5e05a1f0079a9ccb873869ff369f6a7f6d6f19`。该 4 场景诊断不是仓库工程套件新增 4 项测试，也不是修正后浏览器验收。

## 实现范围

生产代码仅涉及 4 个文件：`apps/web/src/forms.tsx`、`apps/web/src/state.tsx`、新增 `apps/web/src/task-creation.ts` 和 `packages/client/src/index.ts`。普通 NewTask 使用既有 Provider 拥有的创建恢复 hook，在首次 POST 前固定原始正文、路径、身份/空间、项目名称和幂等键。所有新建入口先恢复同身份/空间中的未结原包，标题/说明/项目锁定；关闭或导航不撤回请求，重复点击共用同步在途保护。

- “确认原创建结果”仅重发原键/原正文。有效 ACK 独立保存；核对 UUID、HX 编号、原 actor 的 owner/creator、空间/项目/可见性、现有契约规范化后的内容、todo/修订 1/空 attention 与相同且有效的创建/更新时间。规范化只用于核对，不改重试正文；当前投影/SSE 不代替原回执。
- 有效 ACK 后 GET 故障保留已接受状态与 Task 编号，“刷新已创建任务”只 GET。旧有效 ACK 可以更新仍属自己的包，但不能刷新、关闭或导航后来会话；创建所属读取检查会话，并尊重后来成功读取的快照。
- 当前项目创建权限失效、身份/空间变化与自己请求的明确访问拒绝清除旧原包；重授不复活，也不能清除替代包。其他明确 4xx 拒绝返回可编辑原输入；网络/5xx/无效 ACK 留在未知原包。
- 未发送草稿仍在 NewTask 本地，关闭即丢弃；已发送原包在 Provider 内存中跨暂时关闭/站内导航保留。不跨硬刷新或身份/空间 Provider 更换，不写浏览器持久存储。

独立静态复核发现，旧创建请求的 401/`SPACE_ACCESS_REVOKED` 会先经 client 广播，再进入调用者 catch；仅在 catch 隔离原包仍可能先让新 Provider 失效。修正为 client 可选 `shouldNotifyAccessLoss`，只在创建 POST 与所属 GET 接入；其他请求默认行为与 ApiError 不变。创建 POST 按原 Provider 代次、当前 actor/space 与请求空间核对，同 Provider 的当前/关闭弹窗/清包后的真实拒绝仍广播，旧身份/空间拒绝不广播。创建所属 GET 另外服从后来的成功读取快照。没有改动 `identity.tsx` 或后端权限。

最终独立静态复核无剩余阻断；这是源码结论，不是 React/浏览器运行证明。本轮不更改后端、模型、HTTP API 或 schema。操作方法见[创建恢复](../../engineering/task-creation-request-recovery.md)。

## 本轮验证状态

### 本地检查与独立复核

完整格式、类型、UI token、服务端与前端构建均通过，最终生产代码稳定后再次完成构建与类型核对；构建只有既有 large-chunk 提示。新鲜 server TypeScript 编译后，既有 `tests/task-create-budget.test.ts` 定向 **8/8**（1,567 ms，0 失败/取消/跳过）通过，覆盖真实 HTTP、创建预算、权限与回执事务；这是既有测试，不计为新增 8 项，也不能证明新增 UI 的恢复行为。

独立静态复核发现并修正上述 client 先广播的时序缺口后，对最终生产/测试源码复核无剩余阻断。静态复核、编译和测试发现均不能替代实际浏览器验收。

### 最终源码的定向诊断

2026-10-03 **06:53:48 UTC** 的最终诊断使用实际完整 `task-creation.ts` 模块、AST 提取的未改写 NewTask `onSubmit`、实际 client、真实回环 HTTP 与独立磁盘 Store；hook 的同步 ref/state/callback/effect 由诊断适配器注入，没有 React 挂载或渲染。三组证据分别为：

| 组别 | 通过范围 | 证据限制 |
| --- | --- | --- |
| **5 个恢复场景** | 请求未达服务、提交后回包丢失、有效 ACK 后 GET 失败、丢失回包后修改表单、带首尾空白正文；保留原键/正文与单次创建效果，已接受后只 GET | 回包丢失由隐藏实际 201 注入，不是 TCP 断连；无 React/浏览器事件 |
| **18 项 HTTP 拒绝事件控制** | 401 与空间撤权的默认 client、当前归属、关闭、清包、项目撤权、Provider 替换、actor/space/header-space 变化 | 使用 HTTP hook、EventTarget 与注入身份状态，只证明这些输入下的生产通知判定；不是实际账号/权限撤销，也不是浏览器生命周期证明 |
| **3 项 readWorkbench 源函数排序** | 后来成功读取优先于旧 GET 的 401、空间撤权拒绝与成功结果 | 实际源函数与 HTTP 排序，Provider 状态仍由诊断注入；无并发 React 渲染或完整刷新生命周期覆盖 |

三组全部通过，不是新增 26 项 Node 工程测试。最终生产源码 SHA256 已逐一核对：

| 文件 | SHA256 |
| --- | --- |
| `apps/web/src/task-creation.ts` | `497943afc627b8801b1de1fc7a3bf02e31f6cc5bb3fb0279e527ebdc2bb5e9bb` |
| `packages/client/src/index.ts` | `336fbb17311f79aae3483fed4dfcdf8f1f2a6fe048fbb29a6d82c615fca39dda` |
| `apps/web/src/state.tsx` | `4f8938b6b0d8d0840e5b4ccbb683d51968080b29f046aea5e14b77d04b5f7159` |

### 浏览器与远端验收待完成

新增 [task-creation-request-recovery.spec.ts](../../../tests/e2e/task-creation-request-recovery.spec.ts) **28 条**用例，独立严格 TypeScript、Prettier、Playwright 发现与 diff 检查通过；最终全量发现 **227 条 / 27 文件**（父 199 + 新增 28）。覆盖私有/项目创建、规范化与单次效果、未知结果/有效 ACK 后只读刷新、跨入口/迟到回应/新编辑器、项目降权撤权与未发送草稿清理、身份/空间/硬刷新、400 与 5xx/无效 ACK，以及真实延迟/当前会话 401、空间 403 的身份失效。这里描述的是首次提交时的测试源码覆盖；首次远端执行及修正见下文。

本地未运行 Chromium，也未复跑受限测试。远端完整工程与真实浏览器 CI 仍待完成；本轮未增加 Node 工程用例，工程数量预期仍为父树的 622 项，实际数量与结果须以本轮 CI 为准。不能把父 CI 或上述 5+18+3 诊断替代这些待验收项。

计划截图为 **`215-task-creation-unknown-dark.png`**（未知结果、桌面深色）与 **`216-task-creation-refresh-mobile-light.png`**（有效 ACK 后刷新失败、390px 浅色）；尚未生成或实际查看。收到本轮精确 head 的 artifact 后须实际查看原图，不用文件存在或父图代替像素验收。

原 102 行仍为 **2 完成 / 78 部分实现 / 22 未实现**。本轮只是原 04-01/03 的可靠性切片，不新增完成项；状态事实与下一项分别由 [21](../21-implementation-status.md) 和 [22](../22-next-delivery.md) 维护。

## CI186：修正新测试的项目选择器

首个远端 head `d202f72a07b9f31589b8ff550df61d3827270af7` 的 [CI186 / 37105111461](https://github.com/ntygod/HEXU/actions/runs/37105111461) 工程 **622/622** 通过（0 失败/取消/跳过，127.9 秒）。浏览器日志记录新创建用例连续 **18 项超时**，开始第 173/227 条后整作业被取消；没有得到全套终态通过，不能作为本轮验收。

已读取专用失败包中的实际 trace、错误快照和 390px 原始失败图。页面的新建弹窗及启用的项目下拉框均存在，测试停在 `getByLabel('放在哪里', { exact: true }).selectOption(...)`，尚未发送创建 POST。该包裹 label 内含 select 的 option 文本，安装版本的 Playwright 标签定位会递归取这些文本，无法与短标签精确匹配；无障碍树的 combobox 名称则为“放在哪里”。统一改为精确 combobox 角色与名称，所有原值、禁用、权限、原包和单次业务效果断言保留。失败时原 helper 的 finally/unroute 还会用页面关闭错误覆盖主因，改由原外层清理统一处理失败，成功路径继续正常解除路由。

专用包 artifact `11268245502` 为 13,637,351 字节，SHA256 `758cad5a47fe69f2d89e436544b65e7910778a1efcf4e5ab4e21697389ec7d14`，已验证摘要后读取。总包超过本环境 32 MiB 限制，未下载或绕过。Playwright 对长输出目录名缩短了 spec 前缀；旧 glob 仅匹配日志中 18 个失败目录的 9 个，改为本 spec 独有的 `task-creation-request-reco*` 前缀后匹配全部 18 个。

这次仅修测试定位/失败清理及失败制品匹配，生产四文件 SHA256 与上述最终诊断完全一致。227 条测试、30 秒单例、10 秒断言、零重试与 25 分钟 job 预算不变。修正后严格 TypeScript、格式、全量发现和独立静态复核通过；新的精确 head 仍需完整 CI 与 215/216 实图验收，不纯重跑原失败树。

## CI187：全套通过后修正冻结值可读性

修正选择器后的 head `11eaddbd5cfffd96b6ee3583b9176155ed6da4f0`、tree `0daeaa85e124d2669b8ae68e72fef040761a4a74` 的 [CI187 / 37107137054](https://github.com/ntygod/HEXU/actions/runs/37107137054) 已完成工程 **622/622**（98.4 秒，0 失败/取消/跳过）、Chromium **227/227**（18.2 分钟），engineering/browser/check 全部 success。全部 28 个新增浏览器场景已实际运行。

2026-10-03 08:01 UTC 取回并核对精确 head 的预览 artifact `11269205097`，3,145,422 字节，SHA256 `06f191a48c09a25336db474b446d75db0c133353aa123adc1a8ed8f39cf03d6e`。实际查看 215/216 以及回归 212/213 共四张原图；原包说明与桌面/390px 底部操作可见。但锁定字段沿用全局 disabled 的 muted 色，浅色原文接近占位文字，不适合核对原创建内容。按原不透明 token 计算的正文对比度约为暗色 3.40、浅色 2.87，尚未计浏览器控件额外透明度。

因此仅在创建表单增加作用域类与 `task-creation.css`：禁用的标题、项目、说明使用现有正文主色及完整 opacity，继续保持 disabled。没有修改原包、回执、权限、导航或其他表单/按钮。原恢复逻辑的 hook/client/Provider hash 不变。现有 215/216 截图前增加实际 computed 颜色、不透明度及文本对比度检查，保留完整原值/禁用/可达性断言；仍为 28 新例、227 总例。

CI187 的绿灯与原图属于上述旧样式 head，不能替代本次可读性修正后的精确 head。新样式已通过格式、类型、UI token 与构建检查，最终完整 CI 与同两张原图仍待重验；不因功能已经通过就跳过实际新图。
