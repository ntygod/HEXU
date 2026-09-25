from pathlib import Path

marker = Path('.staging/applied-03')
if marker.exists():
    raise SystemExit(0)

def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == 1, (path, old[:100], s.count(old))
    p.write_text(s.replace(old, new))

# The internal DTO uses null for an unspecified model; the public wire fixture must
# use the documented omitted/empty text form rather than reparsing the internal DTO.
replace('tests/continuations.test.ts', "    ...initial,\n    requestedTool: 'codex',", "    ...initial,\n    model: '',\n    requestedTool: 'codex',")
replace('tests/continuations.test.ts', '  const start = async () => {', "  const start = async (prompt = 'FIXTURE_HANG') => {")
replace('tests/continuations.test.ts', 'const response = await post(`tasks/${task.id}/runs`, body());', "const response = await post(`tasks/${task.id}/runs`, body('claude-code', prompt));")
replace('tests/fixtures/native-tool.ts', "emit({ type: 'system', subtype: 'init', session_id: 'fixture-session' });", "emit({ type: 'system', subtype: 'init', session_id: 'fixture-session' });\n// Test-only bounded natural completion; never invokes a model.\nif (input.includes('FIXTURE_DELAY')) await new Promise((resolve) => setTimeout(resolve, 800));")
p = Path('tests/continuations.test.ts')
p.write_text(p.read_text() + '''

test('自然结束策略不发停止请求，原执行成功后接续且不改任务完成状态', async () => {
  const f = await environment();
  try {
    const source = await f.start('FIXTURE_DELAY');
    const response = await f.post(`tasks/${f.task.id}/continuations`, {
      ...f.body('codex', 'CODEX_WRITE'), sourceRunId: source.id, onActiveRun: 'wait',
    });
    assert.equal(response.statusCode, 202);
    assert.equal((await f.getOp(response.json().id)).state, 'waiting_for_stop');
    const op = await f.waitOp(response.json().id);
    assert.equal(op.state, 'succeeded', JSON.stringify(op.blockers));
    const original = f.store.run(source.id);
    assert.equal(original.state, 'succeeded');
    assert.equal(original.native?.terminationConfirmed, true);
    const target = await until(() => f.store.run(op.runId!), (r) => ['succeeded', 'failed', 'cancelled'].includes(r.state));
    assert.equal(target.state, 'succeeded');
    assert.ok(target.createdAt >= original.updatedAt);
    assert.equal(f.store.getTask(f.task.id).status, 'in_progress');
  } finally { await f.close(); }
});
''')

p = Path('docs/engineering/native-execution.md')
s = p.read_text()
s = s.replace('# E1b｜本机双工具与代码现场接续', '# E1c｜本机双工具与持久化接续')
s = s.replace('2026-09-25。实验性本地接入', '2026-09-26（UTC+8）。实验性本地接入')
s = s.replace('尚未使用真实 Claude Code 与有效 Anthropic 账户进行端到端联调', '尚未使用有效 Anthropic 或 OpenAI 账户完成真实模型端到端联调')
old = '原执行还在工作时，先请求停止并等待，再点击开始。当前没有实现后台等待 Operation、页面关闭后自动开跑、同工具原生 resume、实时追加、跨电脑迁移或完整项目知识组装。完成任务后继续需要显式重开；不会因为 AI 结束而自动完成任务。重复请求返回同一 Run，不重复付费启动。'
assert old in s
s = s.replace(old, '''原执行还在工作时，点击“准备接续”，选择“请求停止原执行，然后继续”或“不打断，等原执行自然结束”。提交后返回持久化 Operation；任务中的接续进度卡可在关闭面板、刷新和重新进入后继续查看。服务仍运行时，页面关闭不会取消已经明确授权的接续。只有原进程确认结束且目录释放后才创建新 Run。

请求停止后的等待上限为 60 秒，自然结束策略的等待上限为 31 分钟。超过上限只暂停接续，不假装原执行已停止、不自动释放实际进程锁。原执行仍遵守它自己的运行超时。目标工具不可用时不会先停止原执行；不会静默改换工具、模型账户或目录。

“取消接续”阻止尚未创建的新执行，但不能撤销已发送的停止请求或已有文件修改。新 Run 已创建后请使用它自己的停止操作。“已创建新执行”不是模型成功或任务完成。

等待期间任务修订或人工要求改变会转为“需要处理”；采用保守判断，标题变化也需要重新配置。原要求、工具配置和来源保留在记录中。原执行结束时的输出与受限 Git 摘录在相同授权目录内重新整理；不是共享范围扩大或无损现场快照。

服务重启将所有待接续操作转为“需要处理”，不会自动重放付费执行；未知原进程继续占用实际目录锁。完成任务后继续仍需要显式重开。重复请求按主体、任务、动作与幂等键返回同一 Operation 的最新状态。

同工具原生 resume、实时追加、跨电脑迁移和完整项目知识组装仍未实现。''')
s = s.replace('使用经官方发布摘要核对的 Codex 0.157.0 Linux 包，本轮执行了', 'E1b 使用经官方发布摘要核对的 Codex 0.157.0 Linux 包执行了')
s = s.replace('本轮无模型协议检查版本，不是自动升级承诺', 'E1b 无模型协议检查版本，不是自动升级承诺')
p.write_text(s)

Path('docs/engineering/adr-0004-durable-continuation.md').write_text('''# ADR-0004｜本机持久化接续不等于自动重跑执行

日期：2026-09-26（UTC+8）。对应 HX-DEV-11-01/02/05 的本机切片。

## 决策

ContinuationOperation 与 Task、Run 分开。操作成功仅指原子提交了新 Run，不代表工具结果成功或任务完成。等待/停止选择由用户显式授权，重复请求使用主体/动作/目标范围内的幂等键。

使用迁移 3 增加操作表。任务与目录各有一个活动接续预约，所有直接 Run 入口也核对它。准备上下文可异步，但最后一次取消、任务、人工上下文与来源检查，以及 Run/目录锁/操作关联/幂等记录提交在同一 SQLite 事务完成，然后才创建进程。

仍支持本机单进程服务，不将这个协调器叫作独立远程 Runner。不新增队列服务、Shell 权限、账户兜底或公共访问地址。

## 失败与恢复

收到停止请求并不代表停止完成。只有原生执行确认终态、目录锁释放后才接续；未知进程保持原锁。停止失败、配置缺失、人工要求变化与等待过期呈现明确阻碍，保留要求供重新配置，不循环重试。

取消不撤销旧停止信号；已经创建的新 Run 使用自己的停止动作。服务重启不重放任何待开始的付费执行；待接续记录转 needs_attention。新 Run 与操作关联既然原子提交，崩溃不会导致操作记录丢失后再创建第二个 Run。

## 范围保留

只支持同机新原生会话；resume、完整权限问答、协助、跨节点、正式权限/存储仍按原任务清单记录未完成。严格任务修订检查暂不区分标题与内容影响；完整 ContextBundle 的逐项选择和固定 Git 检查点仍待后续工作。

接续调用代码与协议替身过程可以验证本地状态、Git 和进程机制，不能证明真实提供方生成或费用已联调。具体检查结果只引用实现状态文档和实际 CI。
''')
marker.write_text('Regression fixture and native operation documentation applied.\n')
