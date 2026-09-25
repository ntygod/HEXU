from pathlib import Path

marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)

def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == count, (path, old[:100], s.count(old), count)
    p.write_text(s.replace(old, new))

replace('packages/db/src/schema.ts', '\n];', '''
  {
    version: 3,
    sql: `
CREATE TABLE continuation_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  working_copy_id TEXT NOT NULL REFERENCES native_workspaces(id),
  state TEXT NOT NULL CHECK(state IN ('waiting_for_stop','preparing','needs_attention','succeeded','cancelled','failed')),
  body TEXT NOT NULL
);
CREATE INDEX continuation_task ON continuation_operations(task_id);
CREATE UNIQUE INDEX continuation_active_task ON continuation_operations(task_id) WHERE state IN ('waiting_for_stop','preparing');
CREATE UNIQUE INDEX continuation_active_copy ON continuation_operations(working_copy_id) WHERE state IN ('waiting_for_stop','preparing');
`,
  },
];''')
p = Path('packages/db/src/store.ts')
p.write_text("import { ContinuationStore, assertNoPendingContinuation } from './continuations.js';\n" + p.read_text())
replace(str(p), "return this.mutate(`run.create:${taskId}`, key, input, () => {\n      const task", "return this.mutate(`run.create:${taskId}`, key, input, () => {\n      assertNoPendingContinuation(this, taskId);\n      const task")
replace(str(p), '''    config: NativeRunConfig,
    key: string,
  ): Run {''', '''    config: NativeRunConfig,
    key: string,
    operationId?: string,
  ): Run {''')
replace(str(p), "return this.mutate(`native.create:${taskId}`, key, input, () => {\n      const task", "return this.mutate(`native.create:${taskId}`, key, input, () => {\n      assertNoPendingContinuation(this, taskId, input.workingCopyId, operationId);\n      if (operationId) new ContinuationStore(this).assertStart(operationId, taskId, input);\n      const task")
replace(str(p), '''      this.event(taskId, 'run.created');
      return run;
    });
  }
  nativeEvents''', '''      this.event(taskId, 'run.created');
      if (operationId) new ContinuationStore(this).attachRun(operationId, run);
      return run;
    });
  }
  nativeEvents''')
replace('apps/runner/src/runtime.ts', 'async create(taskId: string, input: NativeRunInput, key: string)', 'async create(taskId: string, input: NativeRunInput, key: string, operationId?: string)')
replace('apps/runner/src/runtime.ts', 'this.store.createNativeRun(taskId, input, config, key)', 'this.store.createNativeRun(taskId, input, config, key, operationId)')
p = Path('apps/control/src/app.ts')
p.write_text("import { ContinuationCoordinator } from '../../runner/src/continuations.js';\nimport { parseContinuation } from '../../../packages/contracts/src/continuation.js';\n" + p.read_text())
replace(str(p), '  const streams = new Set<ServerResponse>();', '  const continuations = new ContinuationCoordinator(store, native);\n  const streams = new Set<ServerResponse>();')
replace(str(p), '''  app.post('/api/v1/tasks/:taskId/continuations', async (request, reply) => {
    const input = parseNativeRunCreate(request.body);
    if (!input.sourceRunId) throw new DomainError('INVALID_CONTINUATION', '继续需要明确来源执行');
    const run = await native.create(param(request.params, 'taskId'), input, key(request.headers));
    return reply.code(201).send(run);
  });''', '''  app.post('/api/v1/tasks/:taskId/continuations', async (request, reply) => {
    const operation = continuations.create(
      param(request.params, 'taskId'), parseContinuation(request.body), key(request.headers),
    );
    return reply.code(202).header('Location', `/api/v1/operations/${operation.id}`).send(operation);
  });
  app.get('/api/v1/tasks/:taskId/continuations', async (request) => ({
    items: continuations.records.list(param(request.params, 'taskId')),
  }));
  app.get('/api/v1/operations/:operationId', async (request) =>
    continuations.records.get(param(request.params, 'operationId')),
  );
  app.post('/api/v1/operations/:operationId/cancel', async (request) =>
    continuations.records.cancel(
      param(request.params, 'operationId'), revision(record(request.body).expectedRevision), key(request.headers),
    ),
  );''')
replace(str(p), "  app.addHook('onClose', async () => {\n    await native.close();", "  app.addHook('onClose', async () => {\n    await continuations.close();\n    await native.close();")
# Preserve the direct-Run safety regressions. New canonical operation-route coverage is separate.
p = Path('tests/codex.test.ts')
p.write_text(p.read_text().replace('/continuations', '/runs'))
p = Path('apps/web/src/App.tsx')
p.write_text("import { ContinuationStatus } from './continuations.js';\n" + p.read_text())
replace(str(p), '''          <Button disabled title="临时协助将在开发计划 11 中接入；本版本不会伪造真人或 AI 回应。">''', '''          {active?.provider === 'native' && (
            <Button onClick={() => setModal('continue')} disabled={task.status === 'cancelled'}>
              <Icon name="arrow-right" />准备接续
            </Button>
          )}
          <Button disabled title="临时协助将在开发计划 11 中接入；本版本不会伪造真人或 AI 回应。">''')
replace(str(p), '      <div className="task-grid">', '      <ContinuationStatus key={id} taskId={id} onConfigure={() => setModal(\'continue\')} />\n      <div className="task-grid">')
p = Path('apps/web/src/native.tsx')
replace(str(p), "  const [consent, setConsent] = useState(false);", "  const [consent, setConsent] = useState(false);\n  const [onActiveRun, setOnActiveRun] = useState<'wait' | 'request_stop'>('request_stop');")
replace(str(p), "...(source ? { sourceRunId: source.id } : {}),", "...(source ? { sourceRunId: source.id, onActiveRun } : {}),")
replace(str(p), 'notice(source ? `已用 ${label} 接续；任务和代码目录保留` : `已派发 ${label} 原生执行`);', 'notice(source ? `已保存 ${label} 接续安排；进度会保留在任务中` : `已派发 ${label} 原生执行`);')
s = p.read_text()
start = s.index('              {awaitingStop && (')
end = s.index('              <label className="field">\n                本次能力', start)
s = s[:start] + '''              {awaitingStop && (
                <div className="notice-box">
                  <div>
                    <strong>原执行尚未确认结束</strong>
                    <p>接续安排会保存。只有确认原进程停止、目录释放后，才会开始新执行。</p>
                    <label className="field">
                      如何处理原执行
                      <select aria-label="如何处理原执行" value={onActiveRun} disabled={busy}
                        onChange={(e) => { setOnActiveRun(e.target.value as 'wait' | 'request_stop'); setConsent(false); }}>
                        <option value="request_stop">请求停止原执行，然后继续</option>
                        <option value="wait">不打断，等原执行自然结束</option>
                      </select>
                    </label>
                    <p>关闭页面不会取消接续；取消接续也不会撤销已发送的停止请求。</p>
                  </div>
                </div>
              )}
''' + s[end:]
s = s.replace('              !!awaitingStop ||\n', '')
s = s.replace('''{task.status === 'done'
              ? '重新打开并继续'
              : source''', '''{awaitingStop
              ? onActiveRun === 'request_stop' ? `停止后用 ${label} 继续` : '原执行结束后继续'
              : task.status === 'done'
                ? '重新打开并继续'
                : source''')
s = s.replace('本次要求会一并发送；只提供部分变更摘录，不搬运模型隐藏状态。', '本次要求会一并发送。等待原执行结束时，会在同一授权目录内重新整理最新输出和部分变更摘录；人工说明变化将暂停接续。')
p.write_text(s)
p = Path('apps/web/src/styles.css')
p.write_text(p.read_text() + '''
/* Persistent local continuation: separate from both Task and Run state. */
.continuation-status { margin: 0 0 18px; padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.continuation-status-heading { display: flex; align-items: flex-start; gap: 12px; }
.continuation-status-title { flex: 1; min-width: 0; }
.continuation-status-title strong { font-size: 15px; }
.continuation-status-title p { color: var(--muted); margin-top: 4px; }
.continuation-status.needs-attention { border-left: 3px solid var(--primary); }
.continuation-steps { display: flex; gap: 24px; list-style: none; padding: 16px 0 8px; margin: 0; counter-reset: continuation; }
.continuation-steps li { color: var(--muted); counter-increment: continuation; font-size: 12px; }
.continuation-steps li::before { content: counter(continuation); display: inline-grid; place-items: center; width: 22px; height: 22px; border: 1px solid var(--line); border-radius: 50%; margin-right: 7px; }
.continuation-steps .current { color: var(--primary); font-weight: 650; }
.continuation-steps .current::before { border-color: var(--primary); }
.continuation-steps .passed { color: var(--text); }
.continuation-status-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.continuation-blocker { display: flex; align-items: flex-start; gap: 6px; margin-top: 12px; }
.continuation-records { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.continuation-records summary { color: var(--muted); cursor: pointer; font-size: 12px; }
.continuation-records article { padding: 14px 0; overflow-wrap: anywhere; }
.continuation-records article + article { border-top: 1px solid var(--line); }
.continuation-prompt { white-space: pre-wrap; margin: 6px 0; }
@media (max-width: 700px) {
  .continuation-status { padding: 14px; }
  .continuation-status-heading { flex-wrap: wrap; }
  .continuation-status-heading > .badge { margin-left: 36px; }
  .continuation-status-actions { align-items: flex-start; flex-wrap: wrap; }
  .continuation-steps { gap: 12px; flex-wrap: wrap; }
}
''')
marker.write_text('E1c source integration applied. Development-only marker.\n')
