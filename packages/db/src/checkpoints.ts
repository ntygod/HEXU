import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseCheckpointCreate,
  parseCheckpointPublish,
  type CheckpointRequest,
  type CommitCheckpoint,
  type CheckpointPage,
  type CheckpointOption,
} from '../../contracts/src/checkpoints.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type { DirectoryGrant } from '../../contracts/src/nodes.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import { NodeRegistry } from './nodes.js';
import type { Store } from './store.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
type RequestRow = {
  id: string;
  task_id: string;
  node_id: string;
  owner_id: string;
  state: string;
  body: string;
  manifest_hash: string | null;
  checkpoint_id: string | null;
};

/** Only explicit, owner-created tickets can receive local immutable-object metadata.
 * The node summary/polling channel cannot create tickets or read arbitrary tasks. */
export class CheckpointStore {
  readonly nodes: NodeRegistry;
  constructor(
    readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {
    this.nodes = new NodeRegistry(store, clock);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private task(id: string, write = false) {
    if (!this.store.teamMode)
      throw new DomainError('TEAM_MODE_REQUIRED', '本批检查点只接入真实账号与本人节点', 404);
    const task = this.store.getTask(id, write);
    if (!task.projectId || task.visibility === 'private')
      throw new DomainError(
        'CHECKPOINT_SCOPE_UNSUPPORTED',
        '本批只记录同项目任务的本机提交，私有任务未接入',
        422,
      );
    return task;
  }
  private row(id: string): RequestRow {
    const row = this.store.db.prepare('SELECT * FROM checkpoint_requests WHERE id=?').get(id) as
      | RequestRow
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '检查点请求不存在或不可访问', 404);
    return row;
  }
  private view(row: RequestRow): CheckpointRequest {
    const body = JSON.parse(row.body) as CheckpointRequest;
    const node = this.store.db
      .prepare('SELECT revision,revoked_at FROM runner_nodes WHERE id=?')
      .get(row.node_id) as { revision: number; revoked_at: string | null } | undefined;
    return {
      ...body,
      checkpointId: row.checkpoint_id,
      state:
        row.state === 'pending' && (!node || node.revoked_at || node.revision !== body.nodeRevision)
          ? 'invalidated'
          : row.state === 'pending' && body.expiresAt <= this.now()
            ? 'expired'
            : (row.state as CheckpointRequest['state']),
    };
  }
  private record(id: string): CommitCheckpoint {
    const r = this.store.db.prepare('SELECT body FROM commit_checkpoints WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    if (!r) throw new DomainError('NOT_FOUND', '检查点记录不存在', 404);
    return JSON.parse(r.body) as CommitCheckpoint;
  }
  get(taskId: string, id: string, write = false): CommitCheckpoint {
    this.task(taskId, write);
    const record = this.record(id);
    if (record.request.taskId !== taskId)
      throw new DomainError('NOT_FOUND', '检查点不属于当前任务', 404);
    return record;
  }
  inspectRecord(token: string, id: string): CommitCheckpoint {
    const record = this.record(id);
    this.inspect(token, record.request.id);
    return record;
  }
  private event(taskId: string, kind: string, spaceId: string) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(taskId, kind, this.now(), spaceId);
  }
  options(taskId: string): { items: CheckpointOption[] } {
    const task = this.task(taskId, true);
    const items = this.nodes
      .list()
      .filter((n) => n.projectId === task.projectId && n.canRevoke && n.presence !== 'revoked');
    return {
      items: items.map((n) => ({ nodeId: n.id, nodeName: n.name, workspaces: n.workspaces })),
    };
  }
  create(taskId: string, input: unknown, key: string): CheckpointRequest {
    this.task(taskId, true);
    const data = parseCheckpointCreate(input);
    this.nodes.ownedExecutionNode(data.nodeId); // Ownership, not a model execution grant.
    const receipt = this.store.mutate(`checkpoint.request:${taskId}`, key, data, () => {
      const task = this.task(taskId, true),
        node = this.nodes.ownedExecutionNode(data.nodeId);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (node.project_id !== task.projectId || node.space_id !== task.spaceId)
        throw new DomainError('NOT_FOUND', '节点不属于当前任务项目', 404);
      const directory = (JSON.parse(node.grants) as DirectoryGrant[]).find(
        (w) => w.id === data.workspaceId,
      );
      if (!directory)
        throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '目录不在节点授权范围', 409);
      const active = this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM checkpoint_requests WHERE owner_id=? AND state='pending' AND json_extract(body,'$.expiresAt')>?",
        )
        .get(this.store.actorId, this.now()) as { n: number };
      const total = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM checkpoint_requests WHERE task_id=?')
        .get(taskId) as { n: number };
      if (active.n >= 20 || total.n >= 1000)
        throw new DomainError('CHECKPOINT_LIMIT', '检查点请求达到上限，请处理已有请求', 409);
      const body: CheckpointRequest = {
        id: randomUUID(),
        taskId,
        taskTitle: task.title,
        projectId: task.projectId!,
        spaceId: task.spaceId,
        nodeId: node.id,
        nodeRevision: node.revision,
        nodeName: node.name,
        workspaceId: directory.id,
        workspaceName: directory.name,
        requestedBy: { id: this.store.actorId, name: this.store.actorName() },
        label: data.label,
        commit: data.commit,
        requestHash: '',
        state: 'pending',
        createdAt: this.now(),
        expiresAt: new Date(this.clock() + 30 * 60000).toISOString(),
        checkpointId: null,
      };
      body.requestHash = hash(body);
      this.store.db
        .prepare(
          "INSERT INTO checkpoint_requests(id,task_id,node_id,owner_id,state,body) VALUES(?,?,?,?,'pending',?)",
        )
        .run(body.id, taskId, node.id, this.store.actorId, JSON.stringify(body));
      this.event(taskId, 'checkpoint.requested', task.spaceId);
      return { id: body.id };
    });
    return this.view(this.row(receipt.id));
  }
  list(taskId: string, cursor: number | null = null): CheckpointPage {
    this.task(taskId);
    const rows = this.store.db
      .prepare(
        'SELECT rowid AS cursor,* FROM checkpoint_requests WHERE task_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21',
      )
      .all(taskId, cursor ?? Number.MAX_SAFE_INTEGER) as (RequestRow & { cursor: number })[];
    const selected = rows.slice(0, 20);
    return {
      requests: selected.map((r) => this.view(r)),
      checkpoints: selected
        .filter((r) => r.checkpoint_id)
        .map((r) => this.record(r.checkpoint_id!)),
      nextCursor: rows.length > 20 ? selected.at(-1)!.cursor : null,
    };
  }
  cancel(taskId: string, id: string, key: string) {
    this.task(taskId, true);
    const check = () => {
      const r = this.row(id);
      if (r.task_id !== taskId || r.owner_id !== this.store.actorId)
        throw new DomainError('NOT_FOUND', '只能取消本人在此任务的请求', 404);
      return r;
    };
    check();
    this.store.mutate(`checkpoint.cancel:${id}`, key, {}, () => {
      this.task(taskId, true);
      const row = check(),
        body = this.view(row);
      if (row.state === 'recorded')
        throw new DomainError('CHECKPOINT_ALREADY_RECORDED', '引用已记录，取消不会删除原记录', 409);
      if (row.state !== 'cancelled') {
        this.store.db
          .prepare("UPDATE checkpoint_requests SET state='cancelled' WHERE id=?")
          .run(id);
        this.event(taskId, 'checkpoint.cancelled', body.spaceId);
      }
      return { id };
    });
    return this.view(check());
  }
  private asNode<T>(
    token: string,
    id: string,
    action: (row: RequestRow, request: CheckpointRequest) => T,
  ): T {
    const node = this.nodes.settlementIdentity(token);
    if (node.settlementOnly) throw new DomainError('NODE_REVOKED', '节点或项目授权已撤销', 401);
    const row = this.row(id),
      request = this.view(row);
    if (
      row.node_id !== node.id ||
      row.owner_id !== node.owner_id ||
      request.spaceId !== node.space_id ||
      request.projectId !== node.project_id
    )
      throw new DomainError('NOT_FOUND', '请求不属于当前节点', 404);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(node.owner_id) as unknown as IdentityUser | undefined;
    if (!user) throw new DomainError('NOT_FOUND', '节点所有者不可访问', 404);
    return this.store.as({ user, spaceId: node.space_id }, () => {
      const task = this.task(row.task_id, true);
      if (
        task.projectId !== request.projectId ||
        node.revision !== request.nodeRevision ||
        !(JSON.parse(node.grants) as DirectoryGrant[]).some((w) => w.id === request.workspaceId)
      )
        throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '原节点或任务范围已变化', 409);
      return action(row, request);
    });
  }
  inspect(token: string, id: string): CheckpointRequest {
    return this.asNode(token, id, (_row, request) => request);
  }
  publish(token: string, input: unknown): { requestId: string; checkpointId: string } {
    const data = parseCheckpointPublish(input);
    return this.store.atomic(() =>
      this.asNode(token, data.requestId, (row, request) => {
        if (
          request.requestHash !== data.requestHash ||
          request.commit !== data.manifest.commit ||
          request.workspaceId !== data.manifest.workingCopy.id
        )
          throw new DomainError('CHECKPOINT_MISMATCH', '核对结果与授权的提交或目录不一致', 409);
        const manifestHash = hash(data.manifest);
        if (row.checkpoint_id) {
          if (row.manifest_hash !== manifestHash)
            throw new DomainError('CHECKPOINT_MISMATCH', '同一请求不得改写已记录的核对结果', 409);
          return { requestId: row.id, checkpointId: row.checkpoint_id };
        }
        if (request.state !== 'pending')
          throw new DomainError(
            'CHECKPOINT_REQUEST_CLOSED',
            '请求已取消或过期，不接受新的检查点',
            409,
          );
        if (
          [data.manifest.verifiedAt, data.manifest.workingCopy.capturedAt].some(
            (t) => Date.parse(t) > this.clock() + 60000 || t < request.createdAt,
          )
        )
          throw new DomainError('CLOCK_SKEW', '核对时间不属于本次请求，请检查本机时钟', 409);
        const checkpointId = randomUUID();
        const record: CommitCheckpoint = {
          id: checkpointId,
          request: { ...request, state: 'recorded', checkpointId },
          manifest: data.manifest,
          recordedAt: this.now(),
        };
        this.store.db
          .prepare('INSERT INTO commit_checkpoints(id,task_id,request_id,body) VALUES(?,?,?,?)')
          .run(checkpointId, row.task_id, row.id, JSON.stringify(record));
        this.store.db
          .prepare(
            "UPDATE checkpoint_requests SET state='recorded',checkpoint_id=?,manifest_hash=? WHERE id=?",
          )
          .run(checkpointId, manifestHash, row.id);
        this.event(row.task_id, 'checkpoint.recorded', request.spaceId);
        return { requestId: row.id, checkpointId };
      }),
    );
  }
}
