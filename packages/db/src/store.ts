import type {
  WorkingCopy,
  NativeRunConfig,
  NativeRunInput,
  NativeEvent,
} from '../../contracts/src/native.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DomainError,
  type Message,
  type Project,
  type Result,
  type Run,
  type RunState,
  type Task,
  type TaskStatus,
  type Workbench,
} from '../../contracts/src/index.js';
import {
  assertRevision,
  assertRunTransition,
  assertTaskChange,
  canReadTask,
  canonicalJson,
  isActiveRun,
} from '../../domain/src/index.js';
import { migrations } from './schema.js';
import { demoMembers, demoProjects, demoTasks, demoUser, SPACE_ID } from './seed.js';

type Row = { body: string };
const decode = <T>(row: unknown): T | undefined =>
  row ? (JSON.parse((row as Row).body) as T) : undefined;
const now = () => new Date().toISOString();

/** Single-process local-preview repository. All writes, outbox and idempotency are atomic. */
export class Store {
  readonly db: DatabaseSync;
  private closed = false;
  constructor(
    path = ':memory:',
    readonly actorId = demoUser.id,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);');
    for (const migration of migrations) {
      if (
        !this.db
          .prepare('SELECT version FROM schema_migrations WHERE version=?')
          .get(migration.version)
      ) {
        this.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_migrations VALUES (?)').run(migration.version);
        });
      }
    }
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) this.seed();
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  mutate<T>(scope: string, key: string, payload: unknown, action: () => T): T {
    if (!key || key.length > 128 || !/^[\w.:-]+$/.test(key))
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '操作需要有效的 Idempotency-Key');
    const fullScope = `${this.actorId}:${scope}`;
    const fingerprint = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT fingerprint,result FROM idempotency_records WHERE scope=? AND key=?')
        .get(fullScope, key) as { fingerprint: string; result: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容', 409);
        return JSON.parse(previous.result) as T;
      }
      const result = action();
      this.db
        .prepare('INSERT INTO idempotency_records VALUES (?,?,?,?)')
        .run(fullScope, key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  private event(taskId: string | null, kind: string) {
    this.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at) VALUES(?,?,?)')
      .run(taskId, kind, now());
  }
  events(after: number, taskId?: string) {
    if (taskId) this.getTask(taskId);
    const rows = this.db
      .prepare(
        'SELECT sequence,task_id AS taskId,kind,created_at AS createdAt FROM outbox WHERE sequence>? ORDER BY sequence LIMIT 100',
      )
      .all(after) as unknown as {
      sequence: number;
      taskId: string | null;
      kind: string;
      createdAt: string;
    }[];
    // Scan cursor progresses across filtered entries without revealing those entries.
    const cursor = rows.at(-1)?.sequence ?? after;
    const visible = rows.filter((row) => {
      if (taskId && row.taskId !== taskId) return false;
      if (!row.taskId) return !taskId;
      try {
        this.getTask(row.taskId);
        return true;
      } catch {
        return false;
      }
    });
    return { cursor, events: visible };
  }
  projects(): Project[] {
    return this.db
      .prepare('SELECT body FROM projects WHERE space_id=? ORDER BY rowid')
      .all(SPACE_ID)
      .map((row) => decode<Project>(row)!);
  }
  project(id: string): Project {
    const result = decode<Project>(
      this.db.prepare('SELECT body FROM projects WHERE id=? AND space_id=?').get(id, SPACE_ID),
    );
    if (!result) throw new DomainError('NOT_FOUND', '项目不存在或不可访问', 404);
    return result;
  }
  createProject(data: { name: string; description: string }, key: string) {
    return this.mutate('project.create', key, data, () => {
      const item: Project = {
        id: randomUUID(),
        spaceId: SPACE_ID,
        ...data,
        color: 'violet',
        revision: 1,
      };
      this.db
        .prepare('INSERT INTO projects VALUES(?,?,?)')
        .run(item.id, SPACE_ID, JSON.stringify(item));
      this.event(null, 'project.created');
      return item;
    });
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT body FROM tasks WHERE space_id=? ORDER BY rowid DESC')
      .all(SPACE_ID)
      .map((row) => decode<Task>(row)!)
      .filter((task) => canReadTask(task, this.actorId, SPACE_ID));
  }
  getTask(id: string): Task {
    const task = decode<Task>(this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id));
    if (!task || !canReadTask(task, this.actorId, SPACE_ID))
      throw new DomainError('NOT_FOUND', '任务不存在或不可访问', 404);
    return task;
  }
  private saveTask(task: Task) {
    this.db
      .prepare('UPDATE tasks SET body=?,project_id=? WHERE id=? AND space_id=?')
      .run(JSON.stringify(task), task.projectId, task.id, SPACE_ID);
    this.event(task.id, 'task.updated');
    return task;
  }
  createTask(data: { title: string; description: string; projectId: string | null }, key: string) {
    return this.mutate('task.create', key, data, () => {
      if (data.projectId) this.project(data.projectId);
      const counter = this.db
        .prepare("SELECT value FROM metadata WHERE key='task_counter'")
        .get() as { value: string };
      const next = Number(counter.value) + 1;
      this.db.prepare("UPDATE metadata SET value=? WHERE key='task_counter'").run(String(next));
      const at = now();
      const task: Task = {
        id: randomUUID(),
        shortId: `HX-${String(next).padStart(3, '0')}`,
        spaceId: SPACE_ID,
        ...data,
        visibility: data.projectId ? 'project' : 'private',
        ownerUserId: this.actorId,
        status: 'todo',
        attention: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.db
        .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
        .run(task.id, SPACE_ID, task.projectId, JSON.stringify(task));
      this.event(task.id, 'task.created');
      return task;
    });
  }
  patchTask(
    id: string,
    data: {
      expectedRevision: number;
      title?: string;
      description?: string;
      attention?: string | null;
    },
    key: string,
  ) {
    this.getTask(id);
    return this.mutate(`task.patch:${id}`, key, data, () => {
      const task = this.getTask(id);
      assertRevision(task.revision, data.expectedRevision);
      const { expectedRevision: _, ...changes } = data;
      return this.saveTask({ ...task, ...changes, revision: task.revision + 1, updatedAt: now() });
    });
  }
  private recordCompletion(task: Task, action: string) {
    this.db
      .prepare('INSERT INTO completion_events VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), task.id, this.actorId, action, task.revision, now());
  }
  changeTask(
    id: string,
    status: TaskStatus,
    expectedRevision: number,
    activeRunAction: 'stop' | 'keep',
    key: string,
  ) {
    this.getTask(id);
    return this.mutate(
      `task.status:${id}`,
      key,
      { status, expectedRevision, activeRunAction },
      () => {
        const task = this.getTask(id);
        assertRevision(task.revision, expectedRevision);
        assertTaskChange(task, status);
        const next = this.saveTask({
          ...task,
          status,
          attention: status === 'done' || status === 'cancelled' ? null : task.attention,
          revision: task.revision + 1,
          updatedAt: now(),
        });
        if (
          status === 'done' ||
          status === 'cancelled' ||
          task.status === 'done' ||
          task.status === 'cancelled'
        )
          this.recordCompletion(
            next,
            status === 'done' ? 'complete' : status === 'cancelled' ? 'cancel' : 'reopen',
          );
        if (activeRunAction === 'stop' && (status === 'done' || status === 'cancelled')) {
          for (const run of this.runs(id).filter((run) => isActiveRun(run.state)))
            this.saveRun({
              ...run,
              state: run.state === 'queued' && run.provider === 'mock' ? 'cancelled' : 'stopping',
              revision: run.revision + 1,
              updatedAt: now(),
            });
        }
        return next;
      },
    );
  }
  messages(taskId: string): Message[] {
    this.getTask(taskId);
    return this.db
      .prepare('SELECT body FROM messages WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => decode<Message>(row)!);
  }
  private insertMessage(
    taskId: string,
    body: string,
    actorType: Message['actorType'],
    actorName: string,
    resultId: string | null = null,
  ) {
    const item: Message = {
      id: randomUUID(),
      taskId,
      body,
      actorType,
      actorName,
      resultId,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(item.id, taskId, JSON.stringify(item));
    this.event(taskId, 'message.created');
    return item;
  }
  addMessage(taskId: string, body: string, resultId: string | null, key: string) {
    this.getTask(taskId);
    if (resultId && this.result(resultId).taskId !== taskId)
      throw new DomainError('INVALID_INPUT', '成果不属于当前任务');
    return this.mutate(`message.create:${taskId}`, key, { body, resultId }, () =>
      this.insertMessage(
        taskId,
        body,
        'human',
        demoMembers.find((member) => member.id === this.actorId)?.name ?? '本地用户',
        resultId,
      ),
    );
  }
  runs(taskId: string): Run[] {
    this.getTask(taskId);
    return this.db
      .prepare('SELECT body FROM runs WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => decode<Run>(row)!);
  }
  run(id: string): Run {
    const run = decode<Run>(this.db.prepare('SELECT body FROM runs WHERE id=?').get(id));
    if (!run) throw new DomainError('NOT_FOUND', '执行不存在', 404);
    this.getTask(run.taskId);
    return run;
  }
  private saveRun(run: Run) {
    this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id);
    this.event(run.taskId, 'run.updated');
    return run;
  }
  createRun(
    taskId: string,
    input: {
      provider: 'mock';
      requestedTool: Run['requestedTool'];
      scenario: Run['scenario'];
      prompt: string;
      expectedRevision: number;
      reopenTask: boolean;
    },
    key: string,
  ) {
    this.getTask(taskId);
    return this.mutate(`run.create:${taskId}`, key, input, () => {
      const task = this.getTask(taskId);
      assertRevision(task.revision, input.expectedRevision);
      if (task.status === 'cancelled' || (task.status === 'done' && !input.reopenTask))
        throw new DomainError('TASK_REOPEN_REQUIRED', '请先重新打开任务', 409);
      if (this.runs(taskId).some((run) => isActiveRun(run.state)))
        throw new DomainError('WORKING_COPY_BUSY', '当前任务还有模拟执行，请先结束或停止', 409);
      if (task.status !== 'in_progress') {
        const next = this.saveTask({
          ...task,
          status: 'in_progress',
          revision: task.revision + 1,
          updatedAt: now(),
        });
        if (task.status === 'done') this.recordCompletion(next, 'reopen');
      }
      const at = now();
      const previous = this.runs(taskId).at(-1);
      const run: Run = {
        id: randomUUID(),
        taskId,
        state: 'queued',
        observation: 'fresh',
        provider: 'mock',
        requestedTool: input.requestedTool,
        scenario: input.scenario,
        previousRunId: previous?.id ?? null,
        prompt: input.prompt,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      };
      this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, taskId, JSON.stringify(run));
      this.insertMessage(
        taskId,
        `开始${input.requestedTool === 'claude-code' ? ' Claude Code' : ' Codex'} 模拟执行。不会调用模型或修改实际代码。${input.prompt ? '\n补充要求：' + input.prompt : ''}`,
        'system',
        'HEXU',
      );
      this.event(taskId, 'run.created');
      return run;
    });
  }
  stepRun(id: string, state: RunState, note?: string): Run {
    return this.transaction(() => {
      const run = this.run(id);
      if (!isActiveRun(run.state) || (run.state === 'stopping' && state !== 'cancelled'))
        return run;
      assertRunTransition(run.state, state);
      const next = this.saveRun({ ...run, state, revision: run.revision + 1, updatedAt: now() });
      if (note)
        this.insertMessage(
          run.taskId,
          note,
          'agent',
          `${run.requestedTool === 'claude-code' ? 'Claude Code' : 'Codex'} · ${run.provider === 'native' ? '原生' : '模拟'}`,
        );
      return next;
    });
  }
  stopRun(id: string, key: string) {
    this.run(id);
    return this.mutate(`run.stop:${id}`, key, {}, () => {
      const run = this.run(id);
      if (!isActiveRun(run.state) || run.state === 'stopping') return run;
      return this.saveRun({
        ...run,
        state: run.state === 'queued' && run.provider === 'mock' ? 'cancelled' : 'stopping',
        revision: run.revision + 1,
        updatedAt: now(),
      });
    });
  }
  resumeRun(
    id: string,
    message: string,
    allowed: boolean,
    key: string,
    expectedState: 'waiting_input' | 'waiting_approval',
  ) {
    this.run(id);
    return this.mutate(`run.resume:${id}`, key, { message, allowed, expectedState }, () => {
      const run = this.run(id);
      if (run.state !== expectedState)
        throw new DomainError('INVALID_TRANSITION', '当前执行不在等待状态', 409);
      this.insertMessage(
        run.taskId,
        message || (allowed ? '允许本次模拟操作' : '拒绝本次模拟操作'),
        'human',
        demoUser.name,
      );
      return this.saveRun({
        ...run,
        state: allowed ? 'running' : 'failed',
        revision: run.revision + 1,
        updatedAt: now(),
      });
    });
  }
  recoverMockRuns() {
    return this.transaction(() => {
      const runs = this.db
        .prepare('SELECT body FROM runs')
        .all()
        .map((row) => decode<Run>(row)!)
        .filter((run) => run.provider === 'mock' && isActiveRun(run.state));
      for (const run of runs) {
        this.saveRun({
          ...run,
          state: 'failed',
          observation: 'fresh',
          revision: run.revision + 1,
          updatedAt: now(),
        });
        this.insertMessage(
          run.taskId,
          '本地预览服务已重启，之前的模拟执行已结束。可以重新开始。',
          'system',
          'HEXU',
        );
      }
      return runs.length;
    });
  }
  // Native execution is opt-in. These methods never spawn a process themselves.
  registerWorkingCopy(item: WorkingCopy): WorkingCopy {
    const previous = decode<WorkingCopy>(
      this.db.prepare('SELECT body FROM native_workspaces WHERE root=?').get(item.root),
    );
    if (previous) return previous;
    this.db
      .prepare('INSERT INTO native_workspaces VALUES(?,?,?)')
      .run(item.id, item.root, JSON.stringify(item));
    return item;
  }
  nativeLock(workingCopyId: string): string | null {
    const row = this.db
      .prepare('SELECT run_id FROM native_workspace_locks WHERE working_copy_id=?')
      .get(workingCopyId) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }
  replayNativeRun(taskId: string, input: NativeRunInput, key: string): Run | null {
    this.getTask(taskId);
    const row = this.db
      .prepare('SELECT fingerprint,result FROM idempotency_records WHERE scope=? AND key=?')
      .get(`${this.actorId}:native.create:${taskId}`, key) as
      | { fingerprint: string; result: string }
      | undefined;
    if (!row) return null;
    if (row.fingerprint !== createHash('sha256').update(canonicalJson(input)).digest('hex'))
      throw new DomainError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容', 409);
    return this.run((JSON.parse(row.result) as Run).id);
  }
  recordNativeReferences(
    id: string,
    refs: { sessionId?: string; turnId?: string; resolvedModel?: string },
  ) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.provider !== 'native' || !run.native || !isActiveRun(run.state)) return;
      this.saveRun({
        ...run,
        native: { ...run.native, ...refs },
        revision: run.revision + 1,
        updatedAt: now(),
      });
    });
  }
  createNativeRun(
    taskId: string,
    input: NativeRunInput,
    config: NativeRunConfig,
    key: string,
  ): Run {
    this.getTask(taskId);
    return this.mutate(`native.create:${taskId}`, key, input, () => {
      const task = this.getTask(taskId);
      assertRevision(task.revision, input.expectedRevision);
      if (input.sourceRunId) {
        const source = this.run(input.sourceRunId);
        if (
          source.taskId !== taskId ||
          source.provider !== 'native' ||
          !source.native ||
          source.native.workingCopyId !== input.workingCopyId
        )
          throw new DomainError('INVALID_CONTINUATION', '来源执行与当前任务或目录不一致', 409);
        if (isActiveRun(source.state) || source.native.terminationConfirmed !== true)
          throw new DomainError(
            'SOURCE_RUN_ACTIVE',
            '先停止原执行并等待确认，再继续；不会强行接管',
            409,
          );
        if (
          this.runs(taskId)
            .filter((r) => r.provider === 'native')
            .at(-1)?.id !== source.id
        )
          throw new DomainError(
            'CONTINUATION_CHANGED',
            '任务已有更新的原生执行，请重新打开继续面板',
            409,
          );
      }
      if (task.status === 'cancelled' || (task.status === 'done' && !input.reopenTask))
        throw new DomainError('TASK_REOPEN_REQUIRED', '请先重新打开任务', 409);
      if (
        this.runs(taskId).some((run) => isActiveRun(run.state)) ||
        this.nativeLock(input.workingCopyId)
      )
        throw new DomainError(
          'WORKING_COPY_BUSY',
          '任务或工作目录仍有执行；失联执行需要在本机核对后恢复',
          409,
        );
      if (task.status !== 'in_progress') {
        const next = this.saveTask({
          ...task,
          status: 'in_progress',
          revision: task.revision + 1,
          updatedAt: now(),
        });
        if (task.status === 'done') this.recordCompletion(next, 'reopen');
      }
      const at = now();
      const run: Run = {
        id: randomUUID(),
        taskId,
        provider: 'native',
        requestedTool: input.requestedTool,
        scenario: 'success',
        prompt: input.prompt,
        state: 'queued',
        observation: 'fresh',
        native: config,
        previousRunId: input.sourceRunId ?? this.runs(taskId).at(-1)?.id ?? null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, taskId, JSON.stringify(run));
      this.db
        .prepare('INSERT INTO native_workspace_locks VALUES(?,?)')
        .run(input.workingCopyId, run.id);
      this.insertMessage(
        taskId,
        `开始 ${input.requestedTool === 'codex' ? 'Codex' : 'Claude Code'} 原生执行（${config.mode === 'edit' ? '允许文件编辑，不提供 Shell' : '只读文件工具'}）。本次使用本机 API key，可能产生模型费用。\n要求：${input.prompt}`,
        'system',
        'HEXU',
      );
      this.event(taskId, 'run.created');
      return run;
    });
  }
  nativeEvents(id: string, after = 0): NativeEvent[] {
    this.run(id);
    return this.db
      .prepare(
        'SELECT sequence,run_id AS runId,kind,body,created_at AS createdAt FROM native_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 200',
      )
      .all(id, after) as unknown as NativeEvent[];
  }
  appendNativeEvent(id: string, kind: NativeEvent['kind'], body: string) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.provider !== 'native') throw new DomainError('INVALID_PROVIDER', '不是原生执行');
      this.db
        .prepare('INSERT INTO native_run_events(run_id,kind,body,created_at) VALUES(?,?,?,?)')
        .run(id, kind, body.slice(0, 12000), now());
      this.event(run.taskId, 'native.event');
    });
  }
  finishNativeRun(
    id: string,
    state: 'succeeded' | 'failed' | 'cancelled',
    note: string,
    terminationConfirmed: boolean,
    sessionId?: string,
  ) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.provider !== 'native' || !run.native)
        throw new DomainError('INVALID_PROVIDER', '不是原生执行');
      if (!isActiveRun(run.state)) return run;
      const next = this.saveRun({
        ...run,
        state: terminationConfirmed ? state : 'stopping',
        observation: terminationConfirmed ? 'fresh' : 'unknown',
        native: {
          ...run.native,
          sessionId: sessionId ?? run.native.sessionId,
          terminationConfirmed,
          recoveryRequired: !terminationConfirmed,
        },
        revision: run.revision + 1,
        updatedAt: now(),
      });
      if (terminationConfirmed)
        this.db.prepare('DELETE FROM native_workspace_locks WHERE run_id=?').run(id);
      this.insertMessage(
        run.taskId,
        note.slice(0, 24000),
        'agent',
        `${run.requestedTool === 'codex' ? 'Codex' : 'Claude Code'} · 原生`,
      );
      return next;
    });
  }
  recoverNativeRuns() {
    return this.transaction(() => {
      for (const task of this.tasks())
        for (const run of this.runs(task.id)) {
          if (
            run.provider !== 'native' ||
            !run.native ||
            !isActiveRun(run.state) ||
            run.observation === 'unknown'
          )
            continue;
          this.saveRun({
            ...run,
            observation: 'unknown',
            native: { ...run.native, recoveryRequired: true },
            revision: run.revision + 1,
            updatedAt: now(),
          });
          this.insertMessage(
            task.id,
            '原生执行连接中断，未自动重新运行，也未释放目录占用。请在本机确认旧进程已停止，再使用 native:recover 恢复。',
            'system',
            'HEXU',
          );
        }
    });
  }
  confirmNativeStopped(id: string) {
    const run = this.run(id);
    if (run.provider !== 'native' || run.observation !== 'unknown')
      throw new DomainError('INVALID_TRANSITION', '只能处理待人工核对的原生执行', 409);
    return this.finishNativeRun(
      id,
      'failed',
      '本机操作者明确确认旧进程已停止；保留此前记录，目录已解除占用。',
      true,
      run.native?.sessionId,
    );
  }
  results(taskId?: string): Result[] {
    if (taskId) this.getTask(taskId);
    const ids = new Set(this.tasks().map((task) => task.id));
    return this.db
      .prepare('SELECT body FROM results ORDER BY rowid DESC')
      .all()
      .map((row) => decode<Result>(row)!)
      .filter((result) => ids.has(result.taskId) && (!taskId || result.taskId === taskId));
  }
  result(id: string): Result {
    const item = decode<Result>(this.db.prepare('SELECT body FROM results WHERE id=?').get(id));
    if (!item) throw new DomainError('NOT_FOUND', '成果不存在', 404);
    this.getTask(item.taskId);
    return item;
  }
  createResult(taskId: string, title: string, body: string, key: string) {
    this.getTask(taskId);
    return this.mutate(`result.create:${taskId}`, key, { title, body }, () => {
      const at = now();
      const result: Result = {
        id: randomUUID(),
        taskId,
        title,
        body,
        kind: 'text',
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.db
        .prepare('INSERT INTO results VALUES(?,?,?)')
        .run(result.id, taskId, JSON.stringify(result));
      this.event(taskId, 'result.created');
      return result;
    });
  }
  detail(id: string) {
    return {
      task: this.getTask(id),
      messages: this.messages(id),
      runs: this.runs(id),
      results: this.results(id),
    };
  }
  workbench(): Workbench {
    return {
      mode: 'local-preview',
      user: demoMembers.find((user) => user.id === this.actorId) ?? demoUser,
      members: demoMembers,
      projects: this.projects(),
      tasks: this.tasks(),
      results: this.results(),
      runs: this.tasks().flatMap((task) => this.runs(task.id)),
    };
  }
  private seed() {
    this.transaction(() => {
      for (const project of demoProjects)
        this.db
          .prepare('INSERT INTO projects VALUES(?,?,?)')
          .run(project.id, SPACE_ID, JSON.stringify(project));
      for (const task of demoTasks)
        this.db
          .prepare('INSERT INTO tasks VALUES(?,?,?,?)')
          .run(task.id, SPACE_ID, task.projectId, JSON.stringify(task));
      this.insertMessage(
        'task-24',
        '按月份导出订单，沿用当前筛选条件。先完成页面，保持现有权限不变。',
        'human',
        '林舟',
      );
      this.insertMessage(
        'task-24',
        '这是用于体验界面的示例记录。右侧展示订单导出预览，不是 AI 刚刚生成的代码。',
        'system',
        'HEXU · 演示资料',
      );
      this.insertMessage('task-24', '数据量大时可能超时，建议考虑后台异步导出。', 'human', '陈一');
      const result: Result = {
        id: 'result-orders',
        taskId: 'task-24',
        title: '订单导出页面',
        body: '示例成果：按月份与状态筛选订单，导出 CSV。\n此预览使用虚构订单，不连接业务系统。',
        revision: 1,
        kind: 'demo-preview',
        createdAt: '2026-09-25T06:40:00.000Z',
        updatedAt: '2026-09-25T06:40:00.000Z',
      };
      this.db
        .prepare('INSERT INTO results VALUES(?,?,?)')
        .run(result.id, result.taskId, JSON.stringify(result));
      this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('task_counter', '35');
      this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('seeded', '1');
    });
  }
}
