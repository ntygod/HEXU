import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseRetentionCreate,
  parseRetentionReport,
  type RetentionTicket,
  type RetentionView,
  type RetentionManifest,
} from '../../contracts/src/checkpoint-retention.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import { CheckpointStore } from './checkpoints.js';
import type { Store } from './store.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
interface Row {
  id: string;
  checkpoint_id: string;
  task_id: string;
  node_id: string;
  owner_id: string;
  body: string;
  state: RetentionView['state'];
  manifest: string | null;
  sequence: number;
  observed_at: string | null;
}
/** Public metadata only. Object bytes are kept by the explicitly authorized owner node. */
export class CheckpointRetentionStore {
  readonly checkpoints: CheckpointStore;
  constructor(
    readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {
    this.checkpoints = new CheckpointStore(store, clock);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private row(id: string) {
    const r = this.store.db
      .prepare('SELECT * FROM checkpoint_retentions WHERE id=?')
      .get(id) as unknown as Row | undefined;
    if (!r) throw new DomainError('NOT_FOUND', '保留请求不存在或不可访问', 404);
    return r;
  }
  private view(r: Row): RetentionView {
    const request = JSON.parse(r.body) as RetentionTicket;
    const n = this.store.db
      .prepare('SELECT revision,revoked_at FROM runner_nodes WHERE id=?')
      .get(r.node_id) as { revision: number; revoked_at: string | null } | undefined;
    const nodeAuthorized = !!n && !n.revoked_at && n.revision === request.nodeRevision;
    const manifest = r.manifest ? (JSON.parse(r.manifest) as RetentionManifest) : null;
    const state =
      r.state === 'pending'
        ? !nodeAuthorized
          ? 'invalidated'
          : request.expiresAt <= this.now()
            ? 'expired'
            : 'pending'
        : r.state === 'retained' && manifest && manifest.expiresAt <= this.now()
          ? 'expired'
          : r.state;
    return {
      request,
      state,
      nodeAuthorized,
      manifest,
      sequence: r.sequence,
      observedAt: r.observed_at,
    };
  }
  private event(r: RetentionTicket, kind: string) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(r.taskId, kind, this.now(), r.spaceId);
  }
  private owner(taskId: string, checkpointId: string) {
    const c = this.checkpoints.get(taskId, checkpointId, true);
    const n = this.checkpoints.nodes.ownedExecutionNode(c.request.nodeId);
    if (c.request.requestedBy.id !== this.store.actorId || n.revision !== c.request.nodeRevision)
      throw new DomainError(
        'CHECKPOINT_SCOPE_CHANGED',
        '只能由原授权节点的本人保留此引用；范围变化后需重新记录',
        409,
      );
    return c;
  }
  create(taskId: string, checkpointId: string, input: unknown, key: string): RetentionView {
    const data = parseRetentionCreate(input);
    this.owner(taskId, checkpointId); // Recheck before old receipt replay.
    const receipt = this.store.mutate(`checkpoint.retain:${checkpointId}`, key, data, () => {
      const c = this.owner(taskId, checkpointId),
        task = this.store.getTask(taskId, true);
      assertRevision(task.revision, data.expectedTaskRevision);
      const count = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM checkpoint_retentions WHERE checkpoint_id=?')
        .get(checkpointId) as { n: number };
      if (count.n >= 32) throw new DomainError('RETENTION_LIMIT', '此引用的保留请求达到上限', 409);
      const t: RetentionTicket = {
        id: randomUUID(),
        checkpointId,
        taskId,
        nodeId: c.request.nodeId,
        nodeRevision: c.request.nodeRevision,
        projectId: c.request.projectId,
        spaceId: c.request.spaceId,
        workspaceId: c.request.workspaceId,
        ownerId: this.store.actorId,
        objectFormat: c.manifest.objectFormat,
        commit: c.manifest.commit,
        tree: c.manifest.tree,
        repositoryIdentity: c.manifest.repositoryIdentity,
        days: data.days,
        requestHash: '',
        createdAt: this.now(),
        expiresAt: new Date(this.clock() + 30 * 60000).toISOString(),
      };
      t.requestHash = hash(t);
      this.store.db
        .prepare(
          'INSERT INTO checkpoint_retentions(id,checkpoint_id,task_id,node_id,owner_id,body) VALUES(?,?,?,?,?,?)',
        )
        .run(t.id, checkpointId, taskId, t.nodeId, this.store.actorId, JSON.stringify(t));
      this.event(t, 'checkpoint.retention.requested');
      return { id: t.id };
    });
    return this.view(this.row(receipt.id));
  }
  list(taskId: string, checkpointId: string): { items: RetentionView[] } {
    this.checkpoints.get(taskId, checkpointId);
    const rows = this.store.db
      .prepare(
        'SELECT * FROM checkpoint_retentions WHERE checkpoint_id=? AND task_id=? ORDER BY rowid DESC LIMIT 32',
      )
      .all(checkpointId, taskId) as unknown as Row[];
    return { items: rows.map((r) => this.view(r)) };
  }
  cancel(taskId: string, checkpointId: string, id: string, key: string) {
    this.checkpoints.get(taskId, checkpointId, true);
    const check = () => {
      const r = this.row(id);
      if (
        r.task_id !== taskId ||
        r.checkpoint_id !== checkpointId ||
        r.owner_id !== this.store.actorId
      )
        throw new DomainError('NOT_FOUND', '只能取消本人在此引用的保留请求', 404);
      return r;
    };
    check();
    this.store.mutate(`checkpoint.retention.cancel:${id}`, key, {}, () => {
      this.checkpoints.get(taskId, checkpointId, true);
      const r = check();
      if (r.manifest)
        throw new DomainError(
          'RETENTION_ALREADY_RECORDED',
          '对象已在本机保留，删除必须在本机明确执行',
          409,
        );
      if (r.state !== 'cancelled') {
        this.store.db
          .prepare("UPDATE checkpoint_retentions SET state='cancelled' WHERE id=?")
          .run(id);
        this.event(JSON.parse(r.body), 'checkpoint.retention.cancelled');
      }
      return { id };
    });
    return this.view(check());
  }
  private asNode<T>(
    token: string,
    id: string,
    action: (row: Row, ticket: RetentionTicket) => T,
  ): T {
    const node = this.checkpoints.nodes.settlementIdentity(token);
    if (node.settlementOnly) throw new DomainError('NODE_REVOKED', '节点授权已撤销', 401);
    const r = this.row(id),
      t = JSON.parse(r.body) as RetentionTicket;
    const c = this.checkpoints.inspectRecord(token, r.checkpoint_id);
    if (
      c.request.nodeId !== t.nodeId ||
      c.request.requestedBy.id !== t.ownerId ||
      c.manifest.repositoryIdentity !== t.repositoryIdentity ||
      c.manifest.commit !== t.commit ||
      c.manifest.tree !== t.tree
    )
      throw new DomainError('CHECKPOINT_MISMATCH', '保留来源已变化', 409);
    return action(r, t);
  }
  inspect(token: string, id: string) {
    return this.asNode(token, id, (r) => this.view(r));
  }
  report(token: string, input: unknown): RetentionView {
    const d = parseRetentionReport(input);
    return this.store.atomic(() =>
      this.asNode(token, d.requestId, (r, t) => {
        if (t.requestHash !== d.requestHash)
          throw new DomainError('CHECKPOINT_MISMATCH', '保留请求指纹不一致', 409);
        const digest = hash(d);
        const old = this.store.db
          .prepare(
            'SELECT body_hash FROM checkpoint_retention_reports WHERE request_id=? AND sequence=?',
          )
          .get(r.id, d.sequence) as { body_hash: string } | undefined;
        if (old) {
          if (old.body_hash !== digest)
            throw new DomainError('CHECKPOINT_MISMATCH', '同序号不能替换核验记录', 409);
          return this.view(r);
        }
        if (
          d.sequence !== r.sequence + 1 ||
          r.state === 'deleted' ||
          d.report.observedAt > new Date(this.clock() + 60000).toISOString() ||
          d.report.observedAt < (r.observed_at ?? t.createdAt)
        )
          throw new DomainError(
            'RETENTION_REPORT_CONFLICT',
            '核验顺序、时间或已删除状态不允许此更新',
            409,
          );
        if (d.report.state === 'retained') {
          const m = d.report.manifest;
          if (this.view(r).state !== 'pending')
            throw new DomainError(
              'CHECKPOINT_REQUEST_CLOSED',
              '保留请求已关闭，不能发布新材料',
              409,
            );
          if (
            m.commit !== t.commit ||
            m.tree !== t.tree ||
            m.repositoryIdentity !== t.repositoryIdentity ||
            m.objectFormat !== t.objectFormat ||
            m.retainedAt !== d.report.observedAt ||
            Date.parse(m.expiresAt) - Date.parse(m.retainedAt) !== t.days * 86400000
          )
            throw new DomainError('CHECKPOINT_MISMATCH', '对象清单或期限不属于本次授权', 409);
          this.store.db
            .prepare('UPDATE checkpoint_retentions SET manifest=? WHERE id=?')
            .run(JSON.stringify(m), r.id);
        } else if (!r.manifest)
          throw new DomainError('RETENTION_REPORT_CONFLICT', '尚未发布保留清单', 409);
        this.store.db
          .prepare('INSERT INTO checkpoint_retention_reports VALUES(?,?,?,?)')
          .run(r.id, d.sequence, digest, JSON.stringify(d.report));
        this.store.db
          .prepare('UPDATE checkpoint_retentions SET state=?,sequence=?,observed_at=? WHERE id=?')
          .run(
            d.report.state === 'verified' ? 'retained' : d.report.state,
            d.sequence,
            d.report.observedAt,
            r.id,
          );
        this.event(t, 'checkpoint.retention.updated');
        return this.view(this.row(r.id));
      }),
    );
  }
}
