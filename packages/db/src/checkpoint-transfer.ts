import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import {
  parseTransferAction,
  parseTransferCreate,
  parseTransferTicket,
  TRANSFER_LIMITS as limits,
  type TransferTicket,
  type TransferView,
  type TransferReply,
  type TransferState,
  type TransferNode,
  type TransferEnvelope,
} from '../../contracts/src/checkpoint-transfer.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import { CheckpointRetentionStore } from './checkpoint-retention.js';
import type { Store } from './store.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
interface Row {
  id: string;
  source_id: string;
  task_id: string;
  body: string;
  state: TransferState;
  recipient_key: string | null;
  envelope: string | null;
  uploaded: number;
  received_at: string | null;
}
interface NodeRow {
  id: string;
  owner_id: string;
  space_id: string;
  project_id: string;
  revision: number;
  revoked_at: string | null;
  name: string;
  platform: string;
  grants: string;
}
const terminal = (s: TransferState) =>
  ['received', 'cancelled', 'expired', 'invalidated'].includes(s);
/** Explicit ciphertext relay. Browser routes expose metadata only; each byte request
 * checks both current owners and immutable node revisions before any old receipt. */
export class CheckpointTransferStore {
  readonly retained: CheckpointRetentionStore;
  constructor(
    readonly store: Store,
    private clock: () => number = Date.now,
  ) {
    this.retained = new CheckpointRetentionStore(store, clock);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private row(id: string) {
    const r = this.store.db
      .prepare('SELECT * FROM checkpoint_transfers WHERE id=?')
      .get(id) as unknown as Row | undefined;
    if (!r) throw new DomainError('NOT_FOUND', '传输不存在或不可访问', 404);
    return r;
  }
  private node(id: string, taskId: string, projectId: string, spaceId: string): NodeRow {
    const n = this.store.db.prepare('SELECT * FROM runner_nodes WHERE id=?').get(id) as unknown as
      | NodeRow
      | undefined;
    if (
      !n ||
      n.revoked_at ||
      n.project_id !== projectId ||
      n.space_id !== spaceId ||
      n.platform !== 'linux'
    )
      throw new DomainError('TRANSFER_SCOPE', '节点不是当前项目的有效 Linux 节点', 409);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(n.owner_id) as unknown as IdentityUser | undefined;
    if (!user) throw new DomainError('TRANSFER_SCOPE', '节点所有者已不可访问', 409);
    this.store.as({ user, spaceId }, () => {
      const task = this.store.getTask(taskId, true);
      if (task.projectId !== projectId || task.visibility === 'private')
        throw new DomainError('TRANSFER_SCOPE', '仅支持双方都有编辑权限的同项目任务', 409);
    });
    return n;
  }
  private target(n: NodeRow): TransferNode {
    const u = this.store.db
      .prepare('SELECT name FROM collab_people WHERE id=?')
      .get(n.owner_id) as { name: string };
    return { id: n.id, ownerId: n.owner_id, revision: n.revision, name: n.name, ownerName: u.name };
  }
  private sides(t: TransferTicket) {
    const s = t.source;
    const source = this.node(s.nodeId, s.taskId, s.projectId, s.spaceId),
      target = this.node(t.target.id, s.taskId, s.projectId, s.spaceId);
    if (
      source.owner_id !== s.ownerId ||
      source.revision !== s.nodeRevision ||
      target.owner_id !== t.target.ownerId ||
      target.revision !== t.target.revision ||
      !(JSON.parse(source.grants) as { id: string }[]).some((w) => w.id === s.workspaceId)
    )
      throw new DomainError('TRANSFER_SCOPE', '原节点或材料范围已经变化', 409);
  }
  private sourceAvailable(t: TransferTicket) {
    const r = this.store.db
      .prepare('SELECT body,manifest,state FROM checkpoint_retentions WHERE id=?')
      .get(t.source.id) as { body: string; manifest: string | null; state: string } | undefined;
    return (
      !!r &&
      r.state === 'retained' &&
      !!r.manifest &&
      canonicalJson(JSON.parse(r.body)) === canonicalJson(t.source) &&
      canonicalJson(JSON.parse(r.manifest)) === canonicalJson(t.manifest) &&
      t.manifest.expiresAt > this.now()
    );
  }
  private view(r: Row): TransferView {
    const ticket = parseTransferTicket(JSON.parse(r.body));
    let authorized = true;
    try {
      this.sides(ticket);
    } catch {
      authorized = false;
    }
    const state = terminal(r.state)
      ? r.state
      : ticket.expiresAt <= this.now()
        ? 'expired'
        : !authorized || !this.sourceAvailable(ticket)
          ? 'invalidated'
          : r.state;
    return {
      ticket,
      state,
      authorized,
      recipientKey: r.recipient_key,
      envelope: r.envelope ? (JSON.parse(r.envelope) as TransferEnvelope) : null,
      uploadedChunks: r.uploaded,
      receivedAt: r.received_at,
    };
  }
  private event(r: Row | TransferTicket, kind: string) {
    const t = 'body' in r ? (JSON.parse(r.body) as TransferTicket) : r;
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(t.source.taskId, kind, this.now(), t.source.spaceId);
  }
  private clear(id: string) {
    this.store.db.prepare('DELETE FROM checkpoint_transfer_chunks WHERE transfer_id=?').run(id);
  }
  /** Bounded expiry/revocation cleanup of ciphertext only; never touches node files. */
  sweep() {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM checkpoint_transfers WHERE state NOT IN ('received','cancelled','expired','invalidated') LIMIT 1000",
      )
      .all() as unknown as Row[];
    for (const r of rows) {
      const v = this.view(r);
      if (v.state === 'expired' || v.state === 'invalidated')
        this.store.atomic(() => {
          this.store.db
            .prepare('UPDATE checkpoint_transfers SET state=? WHERE id=?')
            .run(v.state, r.id);
          this.clear(r.id);
          this.event(r, 'checkpoint.transfer.closed');
        });
    }
  }
  options(taskId: string, checkpointId: string, sourceId: string) {
    const source = this.retained.get(taskId, checkpointId, sourceId);
    this.store.getTask(taskId, true);
    if (source.request.ownerId !== this.store.actorId)
      throw new DomainError('NODE_OWNER_REQUIRED', '只有原节点本人可选择发送材料', 403);
    const s = source.request;
    const rows = this.store.db
      .prepare('SELECT * FROM runner_nodes WHERE project_id=? AND space_id=? AND id!=? LIMIT 200')
      .all(s.projectId, s.spaceId, s.nodeId) as unknown as NodeRow[];
    return {
      items: rows.flatMap((n) => {
        try {
          return [this.target(this.node(n.id, taskId, s.projectId, s.spaceId))];
        } catch {
          return [];
        }
      }),
    };
  }
  create(taskId: string, checkpointId: string, sourceId: string, input: unknown, key: string) {
    const data = parseTransferCreate(input);
    const check = () => {
      const source = this.retained.get(taskId, checkpointId, sourceId);
      this.store.getTask(taskId, true);
      const n = this.retained.checkpoints.nodes.ownedExecutionNode(source.request.nodeId);
      if (
        source.request.ownerId !== this.store.actorId ||
        n.revision !== source.request.nodeRevision
      )
        throw new DomainError('TRANSFER_SCOPE', '只能发送原本人节点的固定材料', 409);
      return source;
    };
    check();
    this.sweep();
    const receipt = this.store.mutate(`checkpoint.transfer:${sourceId}`, key, data, () => {
      const source = check(),
        s = source.request,
        m = source.manifest;
      assertRevision(this.store.getTask(taskId, true).revision, data.expectedTaskRevision);
      if (
        !m ||
        source.state !== 'retained' ||
        !source.nodeAuthorized ||
        s.nodeId === data.targetNodeId ||
        m.coverage.bytes > limits.bytes ||
        m.coverage.objects > limits.objects
      )
        throw new DomainError(
          'TRANSFER_NOT_AVAILABLE',
          '需有效独立对象副本、不同接收节点，且不超过 16 MiB / 2048 个对象',
          409,
        );
      const target = this.node(data.targetNodeId, taskId, s.projectId, s.spaceId);
      const sourceNode = this.node(s.nodeId, taskId, s.projectId, s.spaceId);
      const total = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM checkpoint_transfers')
        .get() as { n: number };
      const perSource = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM checkpoint_transfers WHERE source_id=?')
        .get(sourceId) as { n: number };
      const active = this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM checkpoint_transfers WHERE state NOT IN ('received','cancelled','expired','invalidated')",
        )
        .get() as { n: number };
      if (total.n >= limits.history || perSource.n >= limits.perSource || active.n >= limits.active)
        throw new DomainError(
          'TRANSFER_LIMIT',
          '当前传输或历史记录已达上限，请先处置未完成传输',
          409,
        );
      const createdAt = this.now();
      const ticket: TransferTicket = {
        version: 1,
        id: randomUUID(),
        source: s,
        target: this.target(target),
        sourceName: sourceNode.name,
        manifest: m,
        createdAt,
        expiresAt: new Date(
          Math.min(Date.parse(createdAt) + 30 * 60000, Date.parse(m.expiresAt)),
        ).toISOString(),
        requestHash: '',
      };
      ticket.requestHash = hash(ticket);
      parseTransferTicket(ticket);
      this.store.db
        .prepare(
          "INSERT INTO checkpoint_transfers(id,source_id,task_id,body,state) VALUES(?,?,?,?,'offered')",
        )
        .run(ticket.id, sourceId, taskId, JSON.stringify(ticket));
      this.event(ticket, 'checkpoint.transfer.requested');
      return { id: ticket.id };
    });
    return this.view(this.row(receipt.id));
  }
  list(taskId: string, checkpointId: string, sourceId: string) {
    this.retained.get(taskId, checkpointId, sourceId);
    return {
      items: (
        this.store.db
          .prepare(
            'SELECT * FROM checkpoint_transfers WHERE source_id=? ORDER BY rowid DESC LIMIT 32',
          )
          .all(sourceId) as unknown as Row[]
      ).map((r) => this.view(r)),
    };
  }
  cancel(taskId: string, checkpointId: string, sourceId: string, id: string, key: string) {
    this.retained.get(taskId, checkpointId, sourceId);
    this.store.getTask(taskId, true);
    const check = () => {
      const r = this.row(id),
        t = JSON.parse(r.body) as TransferTicket;
      if (
        r.source_id !== sourceId ||
        r.task_id !== taskId ||
        ![t.source.ownerId, t.target.ownerId].includes(this.store.actorId)
      )
        throw new DomainError('NOT_FOUND', '只能取消本人作为收发方的原传输', 404);
      return r;
    };
    check();
    this.store.mutate(`checkpoint.transfer.cancel:${id}`, key, {}, () => {
      const r = check();
      this.cancelRow(r);
      return { id };
    });
    return this.view(check());
  }
  private cancelRow(r: Row) {
    if (r.state === 'received')
      throw new DomainError(
        'TRANSFER_RECEIVED',
        '对方已报告收到；取消不能删除已交付的本机副本',
        409,
      );
    if (!terminal(r.state)) {
      this.store.db
        .prepare("UPDATE checkpoint_transfers SET state='cancelled' WHERE id=?")
        .run(r.id);
      this.clear(r.id);
      this.event(r, 'checkpoint.transfer.cancelled');
    }
  }
  command(token: string, input: unknown): TransferReply {
    const p = parseTransferAction(input);
    // Authenticate before maintenance; arbitrary unauthenticated traffic cannot trigger a sweep.
    const node = this.retained.checkpoints.nodes.settlementIdentity(token);
    if (node.settlementOnly) throw new DomainError('NODE_REVOKED', '节点授权已撤销', 401);
    const candidate = this.row(p.transferId),
      ticket = JSON.parse(candidate.body) as TransferTicket;
    if (![ticket.source.nodeId, ticket.target.id].includes(node.id))
      throw new DomainError('NOT_FOUND', '传输不属于此节点', 404);
    this.sweep();
    return this.store.atomic(() => {
      const r = this.row(p.transferId),
        t = JSON.parse(r.body) as TransferTicket;
      this.sides(t); // Including receipt replay. No source token ever travels to the recipient.
      const sender = node.id === t.source.nodeId;
      const reply = (): TransferReply => ({ view: this.view(this.row(r.id)) });
      if (p.action === 'inspect') return reply();
      if (p.requestHash !== t.requestHash)
        throw new DomainError('TRANSFER_CONFLICT', '请求指纹已变化', 409);
      if (p.action === 'cancel') {
        this.cancelRow(r);
        return reply();
      }
      if (
        p.action === 'received' &&
        !sender &&
        r.state === 'received' &&
        p.snapshotHash === t.manifest.snapshotHash
      )
        return reply();
      if (terminal(r.state) || t.expiresAt <= this.now() || !this.sourceAvailable(t))
        throw new DomainError('TRANSFER_CLOSED', '传输已结束或材料失效，不再读写字节', 409);
      if (
        (['begin', 'upload', 'seal'].includes(p.action) && !sender) ||
        (['accept', 'chunk', 'received'].includes(p.action) && sender)
      )
        throw new DomainError('TRANSFER_ROLE', '收发角色不能互用', 403);
      if (p.action === 'accept') {
        if (r.recipient_key && r.recipient_key !== p.publicKey)
          throw new DomainError('TRANSFER_CONFLICT', '接收公钥已固定，不能重新生成或更换', 409);
        if (!r.recipient_key) {
          this.store.db
            .prepare("UPDATE checkpoint_transfers SET recipient_key=?,state='accepted' WHERE id=?")
            .run(p.publicKey, r.id);
          this.event(r, 'checkpoint.transfer.accepted');
        }
        return reply();
      }
      if (p.action === 'begin') {
        if (!r.recipient_key)
          throw new DomainError('TRANSFER_CONSENT_REQUIRED', '需接收端先在本机明确同意', 409);
        if (r.envelope && canonicalJson(JSON.parse(r.envelope)) !== canonicalJson(p.envelope))
          throw new DomainError('TRANSFER_CONFLICT', '发送包已固定，不能替换材料或重新加密', 409);
        if (!r.envelope) {
          this.store.db
            .prepare("UPDATE checkpoint_transfers SET envelope=?,state='uploading' WHERE id=?")
            .run(JSON.stringify(p.envelope), r.id);
          this.event(r, 'checkpoint.transfer.started');
        }
        return reply();
      }
      if (!r.envelope) throw new DomainError('TRANSFER_NOT_READY', '尚无固定发送包', 409);
      const e = JSON.parse(r.envelope) as TransferEnvelope;
      if (p.action === 'upload') {
        const data = Buffer.from(p.ciphertext, 'base64'),
          digest = createHash('sha256').update(data).digest('hex');
        const expected = Math.min(limits.chunk, e.bytes - (p.sequence - 1) * limits.chunk) + 16;
        if (
          p.sequence > e.chunks ||
          data.length !== expected ||
          data.toString('base64') !== p.ciphertext ||
          digest !== p.hash
        )
          throw new DomainError('TRANSFER_CORRUPT', '密文块长度、序号或指纹不符', 409);
        const old = this.store.db
          .prepare('SELECT hash FROM checkpoint_transfer_chunks WHERE transfer_id=? AND sequence=?')
          .get(r.id, p.sequence) as { hash: string } | undefined;
        if (old) {
          if (old.hash !== digest)
            throw new DomainError('TRANSFER_CONFLICT', '同序号不能替换密文', 409);
          return { ...reply(), sequence: p.sequence, hash: digest };
        }
        if (r.state !== 'uploading' || p.sequence !== r.uploaded + 1)
          throw new DomainError('TRANSFER_SEQUENCE', '密文块必须按原顺序写入', 409);
        this.store.db
          .prepare('INSERT INTO checkpoint_transfer_chunks VALUES(?,?,?,?)')
          .run(r.id, p.sequence, digest, data);
        this.store.db
          .prepare('UPDATE checkpoint_transfers SET uploaded=? WHERE id=?')
          .run(p.sequence, r.id);
        return { ...reply(), sequence: p.sequence, hash: digest };
      }
      if (p.action === 'seal') {
        if (r.state === 'available') return reply();
        const chunks = this.store.db
          .prepare(
            'SELECT data FROM checkpoint_transfer_chunks WHERE transfer_id=? ORDER BY sequence',
          )
          .all(r.id) as unknown as { data: Uint8Array }[];
        const h = createHash('sha256');
        let bytes = 0;
        for (const c of chunks) {
          h.update(c.data);
          bytes += c.data.length;
        }
        if (
          r.uploaded !== e.chunks ||
          chunks.length !== e.chunks ||
          bytes !== e.bytes + 16 * e.chunks ||
          h.digest('hex') !== e.digest
        )
          throw new DomainError('TRANSFER_INCOMPLETE', '完整密文尚未保存，不能供接收', 409);
        this.store.db
          .prepare("UPDATE checkpoint_transfers SET state='available' WHERE id=?")
          .run(r.id);
        this.event(r, 'checkpoint.transfer.available');
        return reply();
      }
      if (r.state !== 'available')
        throw new DomainError('TRANSFER_NOT_READY', '尚未完成密文上传', 409);
      if (p.action === 'chunk') {
        const c = this.store.db
          .prepare(
            'SELECT hash,data FROM checkpoint_transfer_chunks WHERE transfer_id=? AND sequence=?',
          )
          .get(r.id, p.sequence) as { hash: string; data: Uint8Array } | undefined;
        if (!c) throw new DomainError('TRANSFER_INCOMPLETE', '密文块不存在', 409);
        return {
          ...reply(),
          sequence: p.sequence,
          hash: c.hash,
          ciphertext: Buffer.from(c.data).toString('base64'),
        };
      }
      if (p.action === 'received') {
        if (p.snapshotHash !== t.manifest.snapshotHash)
          throw new DomainError('TRANSFER_CORRUPT', '接收核验与原快照不一致', 409);
        this.store.db
          .prepare("UPDATE checkpoint_transfers SET state='received',received_at=? WHERE id=?")
          .run(this.now(), r.id);
        this.clear(r.id);
        this.event(r, 'checkpoint.transfer.received');
        return reply();
      }
      throw new DomainError('INVALID_INPUT', '不支持的传输操作');
    });
  }
}
