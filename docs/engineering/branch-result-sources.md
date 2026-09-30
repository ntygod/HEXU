# 方案成果来源预览

> HX-DEV-13-03 的只读来源接口。[方案现场](branch-workspaces.md)之后使用；不可变保存现已通过[方案成果](branch-results.md)另行交付，当前范围见[21](../development/21-implementation-status.md)，后续看[22](../development/22-next-delivery.md)。

## 入口与前提

在 `team-local` 的现有登录会话和当前空间内请求：

```http
GET /api/v1/tasks/:taskId/work-branches/:branchId/result-source
```

只接受当前可读父任务下的方案，不增加跨任务、跨项目或匿名分享权限。项目查看者可读取；成员撤权后相同URL不再可读。响应包含 `Cache-Control: no-store`。preview模式不注册此接口。

方案须已关联独立节点Run，并且Run为已确认停止的 `succeeded`、`failed` 或 `cancelled`，观察为fresh、节点阶段为terminal。尚未关联、仍运行、观察未知、终止未确认或关联不一致时拒绝；不会替用户停止进程、解除目录锁、重跑工具或修改数据库业务记录。

## 读取的内容

| 字段 | 含义与边界 |
| --- | --- |
| `start` / `startHash` | 方案组保存的共同任务说明和输入提交引用；不是本轮输出代码 |
| `binding` | 原方案、组、现场准备操作与起点绑定；与Run、派发、现场记录逐项核对 |
| `run` | 来源Run的ID/修订/终态、工具/模型、节点/目录ID及时间；不返回启动generation或私有会话引用 |
| `input` | 原派发中实际持久化的上下文和Run要求，不采用任务后来编辑的说明 |
| `output.text` | 已共享output事件按序连接的UTF-8完整前缀，保留空白；最多24 KiB，不加伪造省略号 |
| `output.availability` | `captured`表示有持久结算边界；`legacy_unavailable`保留旧来源元数据但没有可采用输出，不补推旧历史 |
| `output.totalBytes` / `retainedBytes` / `truncated` | 共享文本连接后的总字节、实际保留字节和是否截取；事件间两个换行也计入预算。24 KiB限制仅指该文本，不是整个响应 |
| `output.digest` | 全部纳入输出事件的序号和已共享文本的SHA-256摘要，包含未展示的尾部；不是工具签名或代码校验 |
| `evidence` | 服务已接收序号、纳入范围的终态边界、边界后忽略的事件数及独立终态报告 |
| `code.status` | 当前恒为 `not_captured`，没有读取活动目录或保存本轮代码 |
| `sourceHash` | 整份来源描述的内容指纹；相同证据重复读取一致，不是授权、版本ID或保存回执 |

输入、输出来自已有共享记录；不发起新模型请求，也不重新读取原生私有历史。服务此前未接收的工具输出不能凭空补齐。来源仍有缺失或已截取时，`limitations`明确说明。

## 终态和迟到事件

节点协议允许在Run已终止后继续接收经验证的迟到事件，而Run.revision不一定变化。本接口先使用持久`terminal_sequence`限定结算范围，再取其中首次terminal事件作为输出边界；只纳入该边界内且`shared`不为false的output事件。terminal说明单独返回，不混成AI正文。边界后事件计数可见，但不能扩大本次成果输出。旧执行没有结算记录时输出为空，终态元数据保留，`toolReportedSuccess`不追认未知证据。

因此迟到事件到达后，`receivedThroughSequence`及`sourceHash`可能变化，而`output.text`和`output.digest`保持不变。修改被截取的尾部时，展示前缀也可能不变，但完整摘要必须变化。

未启动就取消的Run可以没有节点terminal事件，不能虚构启动或工具成功。已启动或有输出但没有完整终态证据时拒绝来源不一致。失败执行的有用输出仍可查看，`toolReportedSuccess`为false；成功也仅指执行报告成功，不代表质量合格或Task完成。

## 错误与只读语义

| 状态 / 代码 | 处理含义 |
| --- | --- |
| 404 | 父任务、方案或关联资源不存在于当前可读范围；不得通过其他ID猜测取回 |
| 409 `WORK_BRANCH_RESULT_NO_RUN` | 方案没有关联Run |
| 409 `WORK_BRANCH_RESULT_NOT_SETTLED` | Run仍活动、观察未知或终止未确认；先按原执行流程处理 |
| 409 `WORK_BRANCH_RESULT_SOURCE_MISMATCH` | 起点、方案、Run、现场、派发或事件序号不一致；不拼接其他方案的材料作为替代 |

这次读取不需要Idempotency-Key，不写Result、不可变版本、方案历史、outbox或保存回执，也不让方案进入ready。现有方案卡的保存/查看版本由[方案成果](branch-results.md)提供，不能把本GET的返回当成已经保存。

固定成果保存在自己的写事务内重查权限和来源条件，原子写入Result版本、方案修订、历史和回执。不可直接信任客户端回传的正文或将本GET包裹成嵌套SQLite事务。不能把来源指纹当成永久访问凭证。

## 实现与定向验证

入口：[路由](../../apps/control/src/work-branches.ts)、[契约](../../packages/contracts/src/work-branch-result-source.ts)、[一致性读取](../../packages/db/src/work-branch-result-source.ts)、[字节边界](../../packages/domain/src/work-branch-result-source.ts)。

在仓库要求的Node24与已安装依赖下：

```sh
npm run build:server
node --test dist/tests/branch-result-output.test.js dist/tests/work-branch-result-source.test.js
```

HTTP测试复用真实同机Git/CLI/节点流程及明确模型协议替身；部分异常通过测试数据库构造，不能视作真实工具行为证明。实际执行结果记录在[实现历史](../development/history/2026-09-29-branch-result-sources.md)，不把新增测试源码本身计作通过证据。
