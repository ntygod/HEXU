# 01｜工程基础与公共契约

> D1 · M0—M1 · 关联 HX-F01/F04/F11/F12 · 依赖：无。  
> [计划入口](README.md) · [数据/API 总表](18-data-api-catalog.md) · [技术依据](20-technical-decisions-sources.md)

## 1. 要交付什么

建立可以让网页、服务和执行器并行开发的工程骨架。尚未接通真实工具时，模拟适配器能产生运行、等待、失败、停止和断线等可见状态；模拟数据与真实数据分开，不能混入项目实际记录。

## 2. 可执行的建议基线

建议使用 TypeScript monorepo：React + Vite 网页、Fastify 控制服务、Node/TypeScript 执行器、PostgreSQL 业务库；包管理器固定一个，建议 pnpm。执行器可在后续有明确打包需求时替换语言，网络契约不绑定 TypeScript。

这是工程拆分的假设，不是已批准选型或最新版本承诺。Node 选择当时获维护且与依赖兼容的 LTS，锁定具体版本；其他依赖由锁文件固定，不在 CI 中每次浮动安装 latest。认证复用成熟组件，经过 IdentityPort 隔离，不自行实现密码学。依据见 20。

```text
apps/web/src/{app,features}
apps/control/src/{modules,workers,transport}
apps/runner/src/{cli,connection,workspaces,processes,storage}
packages/contracts/src/{http,events,runner,adapters}
packages/domain/src/{tasks,runs,permissions}
packages/db/{migrations,queries}
packages/ui/src/{tokens,components}
packages/adapters/{mock,claude-code,codex}
packages/client/src
infra/{compose,proxy}
```

这是未来目录，不在本次文档提交中建立空壳应用。web 不导入服务端密钥或数据库实现；domain 不导入 React 或原生 SDK；适配器只依赖 contracts 和执行器提供的受控宿主能力。

## 3. 三条接口边界

**浏览器↔控制服务：**JSON HTTP API，前缀 `/api/v1`；变更用带会话的请求，实时接收优先 SSE。交互终端和预览隧道另用鉴权 WebSocket，不能把 SSE 当作双向命令通道。

**控制服务↔执行器：**执行器主动 WSS 外连。握手协商协议主版本、能力和节点身份。命令、确认、事件都有唯一 ID；断线可以恢复确认游标，关键记录先持久化再确认收到。

**执行器↔原生工具：**Adapter 接口返回能力、事件、输入响应和终止结果。协议未知或版本不匹配时明确降级，不从 stdout 的自然语言猜测任务完成。

## 4. 公共约定

业务 ID 使用不透明字符串；部署可用 UUID，展示用任务短号。API 以 `spaceId` 表达产品中的 Workspace，代码现场用 `workingCopyId`，不能都叫 workspace。时间 UTC 存储、ISO 8601 输出，显示按用户时区。

列表采用 cursor/limit；详情响应含 `revision`。需要并发控制的写请求使用 `expectedRevision`，不匹配返回 409。创建 Run、接手、完成、分享和外部触发使用 `Idempotency-Key`，键作用域包含主体、目标和动作；同键不同请求内容返回冲突。

```json
{
  "error": {
    "code": "WORKING_COPY_BUSY",
    "message": "当前工作目录仍有执行在写入",
    "retryable": false,
    "details": {"action": "wait_or_use_copy"}
  },
  "requestId": "req_demo"
}
```

详情受权限过滤，不向无访问权的人泄露目录、文件、存在性或成员信息。成功写业务状态与待发送事件放在同一事务，outbox 工作者负责后续发送。不是全量事件溯源，也不保证所有外部动作恰好一次。

## 5. 基础数据与模拟

迁移文件按包分段，由单一迁移历史执行。新增非空字段先考虑已有数据，虽然当前仓库没有运行数据库，也不要设计第二套 v1.0 验收模型。01 先提供连接、事务、迁移和基础附件接口；业务表在归属计划中实现。

附件抽象必须支持本地开发存储和生产对象存储，不把 `/mnt/data` 或作者电脑路径写进应用。上传、最终确认和业务关联分开；失败的临时文件有清理策略。私有文件不能直接用永久公开 URL。

模拟适配器支持固定场景文件：正常结束、等待输入、等待授权、取消竞态、节点失联、缺少模型、用量未知。开发网页能选择场景，但生产配置中默认关闭模拟入口。

## 6. 详细工作项

| ID | 工作内容 | 代码/文档产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-01-01 | 记录建议栈的实际采用值、目标系统与版本锁定方式；维护组件许可证清单 | 工程决策记录与工具链配置 | 无 |
| HX-DEV-01-02 | 建立应用、共享包、环境变量样例、统一启动和静态检查脚本 | monorepo 骨架与开发说明 | 01-01 |
| HX-DEV-01-03 | 定义 HTTP、事件、节点、适配器运行时 schema；生成客户端类型 | contracts、client、错误码 | 01-02、18 草案 |
| HX-DEV-01-04 | 建立 SQL 迁移、事务封装、outbox 与附件存储端口 | db、storage、迁移入口 | 01-03 |
| HX-DEV-01-05 | 制作模拟适配器和统一演示数据，不包含真人/客户资料 | mock adapter、fixture | 01-03 |
| HX-DEV-01-06 | 提供最小自托管开发组合、构建 CI 和配置诊断 | Compose 样例、构建任务、health | 01-02、01-04 |

## 7. 实现交付说明

预期开发命令为安装、开发、构建、类型检查、迁移等，实际名称写入根说明后才视为可用。初始部署包括网页、控制服务、数据库和文件持久化；完整安装升级在 17 展开，不因此推迟 M1 的最小可运行部署。

本包提交应能解释每个应用如何启动，以及 API、事件、模拟器如何消费同一 schema。内部团队自行选择回归方式；不要创建一个业务“验证管理”菜单。
