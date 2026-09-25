from pathlib import Path

marker = Path('.staging/applied-04')
if marker.exists():
    raise SystemExit(0)
p = Path('docs/development/21-implementation-status.md')
s = p.read_text()
old = '**本轮结果尚未登记；以具体 CI 记录为准。** 新增测试覆盖持久化、取消竞态、原子回滚、上下文变化、重复请求、未知进程、超时、实际协议替身进程和浏览器流程。测试定义存在不等于已经通过。'
assert old in s
s = s.replace(old, '''[E1c 完整检查 36172128721](https://github.com/ntygod/HEXU/actions/runs/36172128721) 已通过。其日志保留的实际检查源码为 `5828c75523d3e8f2ea1600be3580295d46990790`；在 GitHub-hosted Ubuntu / Node 24 下运行，不是本地容器结果。

| 检查 | 实际结果 |
| --- | --- |
| 锁文件全新安装、格式检查 | 通过 |
| 服务端/浏览器 TypeScript | 通过 |
| 领域、存储、API、协议、Git、进程与接续测试 | 70 条通过，无跳过 |
| 前后端构建 | 通过 |
| Chromium 浏览器流程 | 17 条通过，0 失败、0 不稳定、0 跳过 |
| 浏览器产物 | 已下载并读取报告；抽查了等待接续和手机深色页面截图 |

新测试实际覆盖等待自然结束、请求停止后继续、取消竞态、事务故障回滚、人工上下文变化、重复请求、未知进程保锁、过期、真实协议替身进程与浏览器操作。真实 Git 文件保留、来源 Run 关联和重复调用次数均有断言，不用截图代替功能测试。

检查过程中曾修正测试数据的 wire/内部 DTO 混用，以及格式问题；没有删除失败用例或增加跳过。主分支最终结果仍以对应提交的只读 CI 为准；上述链接记录的是可追溯开发快照。''')
p.write_text(s)

p = Path('docs/development/18-data-api-catalog.md')
s = p.read_text()
assert '## E1c 实现子集' not in s
s += '''

## E1c 实现子集：本机接续 Operation

以下是当前代码，不替代上文的完整团队契约。仅本机示例主体，没有正式会话/成员授权；类型源为 `packages/contracts/src/continuation.ts`，数据库为 SQLite 迁移 3。

| 路由 | 当前语义 |
| --- | --- |
| `POST /tasks/:taskId/continuations` | `202` + ContinuationOperation；Location 指向 `/api/v1/operations/:id` |
| `GET /tasks/:taskId/continuations` | `{ items }`，最近 20 项，包含保留要求与来源 |
| `GET /operations/:id` | 操作当前状态、revision、blockers、runId |
| `POST /operations/:id/cancel` | 必须有 expectedRevision 和幂等键；尚未创建目标 Run 时取消 |
| `POST /tasks/:taskId/runs` | 仍为 `201` + Run；直接路径也核对待接续任务/目录预约 |

接续输入沿用显式原生配置，必须有 sourceRunId、workingCopyId、requestedTool、prompt、expectedRevision、confirmExecution=true；另必须选择 `onActiveRun=wait/request_stop`。已完成任务需要显式 reopenTask。密钥只来自本机独立配置，不接受由任务文本或 Operation 传入。

状态是 waiting_for_stop / preparing / needs_attention / succeeded / cancelled / failed。succeeded 仅说明新 Run 与操作关联已经原子提交；Task 和 Run 仍各自表达完成与执行结果。开始后的操作取消返回 RUN_ALREADY_STARTED，随后使用 Run 停止动作。

本机实现将人工说明变化、任务修订变化、未知源进程、目录占用、目标能力缺失、等待过期变为明确阻碍；不会因此转移责任、跨目录、扩大权限或自动改用其他账号。重启不重试待开始的付费执行。完整 AccessGrant、Operation 跨节点调度与共享上下文选择仍未实现。
'''
p.write_text(s)

# Align the new status surface with existing workspace gutters, including small screens.
p = Path('apps/web/src/styles.css')
s = p.read_text()
old = '.continuation-status {\n  margin: 0 0 18px;'
assert old in s
s = s.replace(old, '.continuation-status {\n  margin: 16px 24px 0;')
old = '@media (max-width: 700px) {\n  .continuation-status {\n    padding: 14px;'
assert old in s
s = s.replace(old, '@media (max-width: 700px) {\n  .continuation-status {\n    margin: 12px 14px 0;\n    padding: 14px;')
s += '''
@media (max-width: 700px) {
  .continuation-status-title { flex-basis: calc(100% - 48px); }
}
'''
p.write_text(s)
marker.write_text('Verified operation API, evidence and final layout documented.\n')
