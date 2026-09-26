import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Message, type Run, type Task } from '../../contracts/src/index.js';
import type {
  DispatchCommand,
  ExecutionEvent,
  ExecutionPolicy,
  NodeExecutionOption,
  NodeRunInput,
} from '../../contracts/src/node-execution.js';
import { NODE_LEASE_MS, type DirectoryGrant } from '../../contracts/src/nodes.js';
import { assertRevision, canonicalJson, isActiveRun } from '../../domain/src/index.js';
import { redact } from '../../adapters/claude-code/src/index.js';
import type { Store } from './store.js';
import type { NodeRegistry } from './nodes.js';

export const executionHash = (v: unknown) =>
  createHash('sha256').update(canonicalJson(v)).digest('hex');
type Row = {
  id: string;
  run_id: string;
  task_id: string;
  node_id: string;
  space_id: string;
  workspace_id: string;
  owner_id: string;
  command: string;
  context_hash: string;
  task_revision: number;
  stage: string;
  last_sequence: number;
  last_hash: string | null;
  updated_at: string;
};
type PolicyRow = { node_id: string; connection_id: string; policy_hash: string; body: string };
const stamp = () => new Date().toISOString();

/** Single-control-process dispatch journal. Commands are fixed, bounded adapter inputs, not RPC. */
export class NodeExecution {
  constructor(
    readonly store: Store,
    readonly nodes: NodeRegistry,
  ) {
    if (!store.teamMode) return;
    store.atomic(() => {
      for (const d of this.rows()) {
        const r = this.run(d);
        if (['queued', 'accepted'].includes(d.stage))
          this.finish(d, 'cancelled', '控制服务已重启，未启动的派发已取消；没有自动重试。');
        else this.save(d, { ...r, observation: 'unknown' }, 'unknown');
      }
    });
  }
  private rows() {
    return this.store.db
      .prepare("SELECT * FROM node_dispatches WHERE stage!='terminal'")
      .all() as Row[];
  }
  private row(id: string) {
    const d = this.store.db.prepare('SELECT * FROM node_dispatches WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!d) throw new DomainError('DISPATCH_NOT_FOUND', '派发不存在', 404);
    return d;
  }
  private run(d: Row): Run {
    return JSON.parse(
      (this.store.db.prepare('SELECT body FROM runs WHERE id=?').get(d.run_id) as { body: string })
        .body,
    );
  }
  private task(d: { task_id: string }): Task {
    return JSON.parse(
      (
        this.store.db.prepare('SELECT body FROM tasks WHERE id=?').get(d.task_id) as {
          body: string;
        }
      ).body,
    );
  }
  private event(d: Row, kind: string) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(d.task_id, kind, stamp(), d.space_id);
  }
  private message(d: Row, body: string, actorType: Message['actorType'] = 'system') {
    if (!body) return;
    const run = this.run(d);
    const m: Message = {
      id: randomUUID(),
      taskId: d.task_id,
      body: body.slice(0, 6000),
      actorType,
      actorName:
        actorType === 'agent'
          ? `${run.requestedTool === 'codex' ? 'Codex' : 'Claude Code'} · 独立节点`
          : 'HEXU',
      createdAt: stamp(),
      resultId: null,
    };
    this.store.db
      .prepare('INSERT INTO messages VALUES(?,?,?)')
      .run(m.id, d.task_id, JSON.stringify(m));
    this.event(d, 'message.created');
  }
  private save(d: Row, run: Run, stage = d.stage) {
    const next: Run = {
      ...run,
      node: {
        ...run.node!,
        phase: stage as NonNullable<Run['node']>['phase'],
        ...(stage === 'accepted' && !run.node?.acceptedAt ? { acceptedAt: stamp() } : {}),
        ...(stage === 'preparing' && !run.node?.permittedAt ? { permittedAt: stamp() } : {}),
        ...(stage === 'running' && !run.node?.startedAt ? { startedAt: stamp() } : {}),
      },
      revision: run.revision + 1,
      updatedAt: stamp(),
    };
    this.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(next), run.id);
    this.store.db
      .prepare('UPDATE node_dispatches SET stage=?,updated_at=? WHERE id=?')
      .run(stage, stamp(), d.id);
    this.event(d, 'run.updated');
    return next;
  }
  private finish(d: Row, state: 'cancelled' | 'failed' | 'succeeded', body: string) {
    const r = this.run(d);
    this.save(
      d,
      { ...r, state, observation: 'fresh', node: { ...r.node!, terminationConfirmed: true } },
      'terminal',
    );
    this.message(d, body);
  }
  private context(task: Task) {
    const messages = (
      this.store.db
        .prepare('SELECT body FROM messages WHERE task_id=? ORDER BY rowid DESC LIMIT 100')
        .all(task.id) as { body: string }[]
    )
      .map((r) => JSON.parse(r.body) as Message)
      .filter((m) => m.actorType === 'human')
      .slice(0, 6)
      .reverse();
    // Same explicit material set is used for the pre-start stale-context check.
    return [
      task.title,
      task.description.slice(0, 5000),
      ...messages.map((m) => `${m.actorName}: ${m.body.slice(0, 800)}`),
    ].join('\n\n');
  }
  publish(token: string, connectionId: string, policy: ExecutionPolicy | null) {
    const n = this.nodes.executionConnection(token, connectionId);
    const grants = JSON.parse(n.grants) as DirectoryGrant[];
    if (policy && policy.workspaceIds.some((id) => !grants.some((g) => g.id === id)))
      throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '执行授权不能增加配对目录', 409);
    return this.store.atomic(() => {
      const hash = policy ? executionHash(policy) : '';
      for (const d of this.rows().filter((d) => d.node_id === n.id)) {
        if (JSON.parse(d.command).policyHash !== hash)
          this.requestStopRow(d, '本机执行授权已改变，旧执行已请求停止。');
      }
      if (policy)
        this.store.db
          .prepare(
            'INSERT INTO node_execution_policies VALUES(?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET connection_id=excluded.connection_id,policy_hash=excluded.policy_hash,body=excluded.body',
          )
          .run(n.id, connectionId, hash, JSON.stringify(policy));
      else this.store.db.prepare('DELETE FROM node_execution_policies WHERE node_id=?').run(n.id);
      return { policyHash: hash };
    });
  }
  private policy(id: string) {
    return this.store.db
      .prepare('SELECT * FROM node_execution_policies WHERE node_id=?')
      .get(id) as PolicyRow | undefined;
  }
  options(taskId: string): { items: NodeExecutionOption[]; contextText: string } {
    const task = this.store.getTask(taskId);
    if (!task.projectId) return { items: [], contextText: this.context(task) };
    return {
      contextText: this.context(task),
      items: this.nodes
        .list()
        .filter((n) => n.canRevoke && n.projectId === task.projectId && !n.revokedAt)
        .flatMap((n) => {
          const p = this.policy(n.id);
          if (!p) return [];
          const raw = this.store.db
            .prepare('SELECT connection_id FROM runner_nodes WHERE id=?')
            .get(n.id) as { connection_id: string };
          const policy = JSON.parse(p.body) as ExecutionPolicy;
          const occupied = !!this.store.db
            .prepare("SELECT 1 FROM node_dispatches WHERE node_id=? AND stage!='terminal'")
            .get(n.id);
          const available =
            n.presence === 'online' && p.connection_id === raw.connection_id && !occupied;
          return [
            {
              nodeId: n.id,
              name: n.name,
              available,
              reason: occupied
                ? '节点仍有执行或待核对现场'
                : available
                  ? '仅节点所有者可发起；模型账户未据此验证'
                  : '节点离线或尚未重新发布执行授权',
              policyHash: p.policy_hash,
              policy,
              workspaces: n.workspaces.filter((w) => policy.workspaceIds.includes(w.id)),
            },
          ];
        }),
    };
  }
  create(taskId: string, input: NodeRunInput, key: string): Run {
    const task = this.store.getTask(taskId, true);
    const node = this.nodes.ownedExecutionNode(input.nodeId); // Always before replay.
    if (task.projectId !== node.project_id)
      throw new DomainError('PROJECT_SCOPE_MISMATCH', '任务与节点不属于同一项目', 409);
    const response = this.store.mutate(`node.run.create:${taskId}`, key, input, () => {
      assertRevision(task.revision, input.expectedRevision);
      const option = this.options(taskId).items.find((n) => n.nodeId === input.nodeId);
      if (!option?.available || option.policyHash !== input.policyHash)
        throw new DomainError(
          'EXECUTION_UNAVAILABLE',
          option?.reason ?? '没有本机明确发布的执行授权',
          409,
        );
      const workspace = option.workspaces.find((w) => w.id === input.workingCopyId);
      if (!workspace || (input.mode === 'edit' && option.policy.mode !== 'edit'))
        throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '目录或编辑能力超出本机授权', 409);
      if (task.status === 'cancelled' || (task.status === 'done' && !input.reopenTask))
        throw new DomainError('TASK_REOPEN_REQUIRED', '请明确重新打开任务后执行', 409);
      if (this.store.runs(taskId).some((r) => isActiveRun(r.state)))
        throw new DomainError('TASK_BUSY', '任务还有未结束执行', 409);
      let taskRevision = task.revision;
      if (task.status === 'done') {
        taskRevision++;
        this.store.db
          .prepare('UPDATE tasks SET body=? WHERE id=?')
          .run(
            JSON.stringify({ ...task, status: 'todo', revision: taskRevision, updatedAt: stamp() }),
            taskId,
          );
      }
      const id = randomUUID(),
        runId = randomUUID(),
        now = stamp();
      const context = this.context(task);
      const command: DispatchCommand = {
        id,
        generation: randomUUID(),
        runId,
        taskId,
        projectId: node.project_id,
        workspaceId: workspace.id,
        policyHash: input.policyHash,
        policy: option.policy,
        mode: input.mode,
        context: `${context}\n\n# 本次要求\n${input.prompt}\n\n只使用已授权文件工具。不得执行 Shell、MCP 或仓库脚本；缺少能力时如实说明。`,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      const run: Run = {
        id: runId,
        taskId,
        provider: 'node',
        state: 'queued',
        observation: 'fresh',
        requestedTool: option.policy.tool,
        scenario: 'success',
        previousRunId: null,
        prompt: input.prompt,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        node: {
          nodeId: node.id,
          nodeName: node.name,
          workingCopyId: workspace.id,
          workingCopyName: workspace.name,
          dispatchId: id,
          policyHash: input.policyHash,
          mode: input.mode,
          model: option.policy.model,
          timeoutSeconds: option.policy.timeoutSeconds,
          maxBudgetUsd: option.policy.maxBudgetUsd,
          phase: 'queued',
          terminationConfirmed: false,
        },
      };
      this.store.db
        .prepare('INSERT INTO runs VALUES(?,?,?)')
        .run(runId, taskId, JSON.stringify(run));
      this.store.db
        .prepare(
          'INSERT INTO node_dispatches(id,run_id,task_id,node_id,space_id,workspace_id,owner_id,command,context_hash,task_revision,stage,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          runId,
          taskId,
          node.id,
          node.space_id,
          workspace.id,
          node.owner_id,
          JSON.stringify(command),
          executionHash(context),
          taskRevision,
          'queued',
          now,
        );
      const d = this.row(id);
      this.message(d, '已保存节点派发；尚未确认接单或启动。输出将共享到当前项目任务。');
      this.event(d, 'run.created');
      return { id: runId };
    });
    return this.store.run(response.id);
  }
  private requestStopRow(d: Row, reason: string) {
    if (d.stage === 'terminal') return;
    if (['queued', 'accepted'].includes(d.stage))
      this.finish(d, 'cancelled', reason + ' 未发出启动许可。');
    else if (this.run(d).state !== 'stopping') this.save(d, { ...this.run(d), state: 'stopping' });
  }
  /** Called after Task completion/cancellation too; never equate stopping with exit. */
  reconcile() {
    if (!this.store.teamMode) return;
    this.store.atomic(() => {
      for (const d of this.rows()) {
        const n = this.store.db
          .prepare(
            'SELECT revoked_at,last_seen_at,server_epoch,disconnected FROM runner_nodes WHERE id=?',
          )
          .get(d.node_id) as {
          revoked_at: string | null;
          last_seen_at: string | null;
          server_epoch: string | null;
          disconnected: number;
        };
        const r = this.run(d),
          c = JSON.parse(d.command) as DispatchCommand;
        if (
          n.revoked_at ||
          r.state === 'stopping' ||
          (['queued', 'accepted'].includes(d.stage) && Date.parse(c.expiresAt) <= Date.now())
        )
          this.requestStopRow(d, '派发已取消或授权过期。');
        else if (
          (!n.last_seen_at ||
            Date.now() - Date.parse(n.last_seen_at) > NODE_LEASE_MS ||
            n.disconnected ||
            n.server_epoch !== this.nodes.epoch) &&
          r.observation !== 'unknown'
        )
          this.save(d, { ...r, observation: 'unknown' });
      }
    });
  }
  poll(token: string, connectionId: string) {
    const node = this.nodes.executionConnection(token, connectionId);
    this.reconcile();
    const d = this.store.db
      .prepare(
        "SELECT * FROM node_dispatches WHERE node_id=? AND stage!='terminal' ORDER BY rowid LIMIT 1",
      )
      .get(node.id) as Row | undefined;
    if (!d) return { command: null, stopRequested: false };
    const policy = this.policy(node.id);
    if (
      !policy ||
      policy.connection_id !== connectionId ||
      policy.policy_hash !== JSON.parse(d.command).policyHash
    )
      return { command: null, stopRequested: true };
    return {
      command: JSON.parse(d.command) as DispatchCommand,
      stopRequested: this.run(d).state === 'stopping',
    };
  }
  permit(token: string, connectionId: string, id: string, generation: string) {
    const node = this.nodes.executionConnection(token, connectionId),
      d = this.row(id),
      c = JSON.parse(d.command) as DispatchCommand;
    if (d.node_id !== node.id || c.generation !== generation)
      throw new DomainError('DISPATCH_NOT_FOUND', '派发不属于当前节点', 404);
    return this.store.atomic(() => {
      const p = this.policy(node.id),
        task = this.task(d),
        r = this.run(d);
      const valid =
        d.stage === 'accepted' &&
        r.state !== 'stopping' &&
        p?.connection_id === connectionId &&
        p.policy_hash === c.policyHash &&
        Date.parse(c.expiresAt) > Date.now() &&
        task.revision === d.task_revision &&
        !['done', 'cancelled'].includes(task.status) &&
        executionHash(this.context(task)) === d.context_hash;
      if (!valid) {
        if (['queued', 'accepted'].includes(d.stage))
          this.finish(d, 'cancelled', '启动前授权、任务或上下文已变化，没有发出启动许可。');
        return { allowed: false }; // Permits are deliberately never replayable launch instructions.
      }
      this.save(d, { ...r, state: 'preparing' }, 'preparing');
      return { allowed: true };
    });
  }
  acceptEvent(token: string, id: string, generation: string, input: ExecutionEvent) {
    const node = this.nodes.settlementIdentity(token),
      d = this.row(id),
      c = JSON.parse(d.command) as DispatchCommand;
    if (d.node_id !== node.id || c.generation !== generation)
      throw new DomainError('DISPATCH_NOT_FOUND', '派发不属于此节点', 404);
    const hash = executionHash(input);
    return this.store.atomic(() => {
      const old = this.store.db
        .prepare('SELECT event_hash FROM node_run_events WHERE dispatch_id=? AND sequence=?')
        .get(d.id, input.sequence) as { event_hash: string } | undefined;
      if (old) {
        if (old.event_hash !== hash)
          throw new DomainError('SEQUENCE_CONFLICT', '同序号事件内容不同', 409);
        return { acknowledgedSequence: input.sequence };
      }
      if (input.sequence !== d.last_sequence + 1 || input.sequence > 128)
        throw new DomainError('SEQUENCE_GAP', '执行事件序号不连续或超限', 409);
      let r = this.run(d);
      const body = node.settlementOnly
        ? '节点权限已撤销；仅接收停止确认，输出不再共享。'
        : redact(input.text, [token]);
      if (node.settlementOnly && !['terminal', 'unknown'].includes(input.kind)) {
        // Discard late output while retaining sequence integrity for terminal settlement.
      } else if (d.stage === 'terminal') {
        // Drain late, validated evidence without reviving or replacing a terminal Run.
      } else if (input.kind === 'accepted') {
        if (d.stage !== 'queued') throw new DomainError('INVALID_TRANSITION', '不能重复接单', 409);
        this.save(
          d,
          { ...r, state: r.state === 'stopping' ? 'stopping' : 'preparing' },
          'accepted',
        );
      } else if (input.kind === 'running') {
        if (!['preparing', 'unknown'].includes(d.stage))
          throw new DomainError('INVALID_TRANSITION', '没有启动许可', 409);
        this.save(
          d,
          { ...r, state: r.state === 'stopping' ? 'stopping' : 'running', observation: 'fresh' },
          'running',
        );
        const task = this.task(d);
        if (task.status === 'todo')
          this.store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
            JSON.stringify({
              ...task,
              status: 'in_progress',
              revision: task.revision + 1,
              updatedAt: stamp(),
            }),
            task.id,
          );
      } else if (input.kind === 'unknown') {
        this.save(d, { ...r, observation: 'unknown' }, 'unknown');
        this.message(d, '节点执行现场需要核对；未重启进程，也未释放目录占用。');
      } else if (input.kind === 'terminal') {
        if (input.result === 'succeeded' && !['running', 'unknown'].includes(d.stage))
          throw new DomainError('INVALID_TRANSITION', '未确认运行的执行不能报告成功', 409);
        this.finish(d, input.result!, body || '节点已确认进程结束；任务是否完成由成员决定。');
      } else {
        if (!['preparing', 'running', 'unknown'].includes(d.stage))
          throw new DomainError('INVALID_TRANSITION', '当前阶段不接受输出', 409);
        this.message(d, body, 'agent');
      }
      this.store.db
        .prepare('INSERT INTO node_run_events VALUES(?,?,?,?)')
        .run(d.id, input.sequence, hash, JSON.stringify({ ...input, text: body }));
      this.store.db
        .prepare('UPDATE node_dispatches SET last_sequence=?,last_hash=? WHERE id=?')
        .run(input.sequence, hash, d.id);
      return { acknowledgedSequence: input.sequence };
    });
  }
}
