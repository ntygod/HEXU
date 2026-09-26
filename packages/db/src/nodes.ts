import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  NODE_INTERVAL_MS,
  NODE_LEASE_MS,
  NODE_OFFLINE_MS,
  nodeSecret,
  parsePair,
  type DirectoryGrant,
  type NodeHello,
  type NodeSnapshot,
  type PairingView,
  type RunnerNode,
} from '../../contracts/src/nodes.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type PairRow = {
  id: string;
  owner_id: string;
  space_id: string;
  project_id: string;
  code_hash: string;
  expires_at: string;
  cancelled: number;
  node_id: string | null;
  created_at: string;
};
type NodeRow = {
  id: string;
  owner_id: string;
  space_id: string;
  project_id: string;
  token_hash: string;
  client_id: string;
  registration_hash: string;
  name: string;
  platform: string;
  arch: string;
  grants: string;
  created_at: string;
  revision: number;
  revoked_at: string | null;
  connection_id: string | null;
  server_epoch: string | null;
  lease_until: number;
  last_seen_at: string | null;
  disconnected: number;
  sequence: number;
  event_hash: string | null;
  snapshot: string | null;
};

/** Metadata-only protocol: no dispatch, credentials, arbitrary file requests or commands. */
export class NodeRegistry {
  readonly epoch = randomUUID();
  constructor(
    readonly store: Store,
    private clock: () => number = Date.now,
  ) {}
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private row(id: string): NodeRow {
    const node = this.store.db.prepare('SELECT * FROM runner_nodes WHERE id=?').get(id) as
      | NodeRow
      | undefined;
    if (!node) throw new DomainError('NOT_FOUND', '节点不存在或不可访问', 404);
    return node;
  }
  private labels(row: { owner_id: string; space_id: string; project_id: string }) {
    const person = this.store.db
      .prepare('SELECT name FROM collab_people WHERE id=?')
      .get(row.owner_id) as { name: string };
    const space = this.store.db
      .prepare('SELECT name FROM collab_spaces WHERE id=?')
      .get(row.space_id) as { name: string };
    const project = this.store.db
      .prepare('SELECT body FROM projects WHERE id=?')
      .get(row.project_id) as { body: string };
    return {
      ownerName: person.name,
      spaceName: space.name,
      projectName: (JSON.parse(project.body) as { name: string }).name,
    };
  }
  private authorized(row: { owner_id: string; space_id: string; project_id: string }) {
    return !!this.store.db
      .prepare(
        `SELECT 1 FROM collab_memberships m
      JOIN collab_project_members pm ON pm.user_id=m.user_id
      JOIN projects p ON p.id=pm.project_id AND p.space_id=m.space_id
      WHERE m.user_id=? AND m.space_id=? AND pm.project_id=? AND pm.role IN ('edit','manage')`,
      )
      .get(row.owner_id, row.space_id, row.project_id);
  }
  private pairingView(row: PairRow): PairingView {
    return {
      id: row.id,
      projectId: row.project_id,
      spaceId: row.space_id,
      ...this.labels(row),
      expiresAt: row.expires_at,
      state:
        row.cancelled || !this.authorized(row)
          ? 'cancelled'
          : row.node_id
            ? 'used'
            : row.expires_at <= this.now()
              ? 'expired'
              : 'pending',
    };
  }
  pairings(): PairingView[] {
    this.store.permissions.space();
    return (
      this.store.db
        .prepare(
          'SELECT * FROM runner_pairings WHERE owner_id=? AND space_id=? ORDER BY rowid DESC LIMIT 20',
        )
        .all(this.store.actorId, this.store.spaceId) as PairRow[]
    )
      .filter((row) => this.store.permissions.projectRole(row.project_id) !== null)
      .map((row) => this.pairingView(row));
  }
  createPairing(projectId: string, key: string) {
    this.store.permissions.project(projectId, 'edit'); // Before any idempotent replay.
    let code: string | null = null;
    const result = this.store.mutate('node.pairing.create', key, { projectId }, () => {
      const count = this.store.db
        .prepare(
          'SELECT COUNT(*) AS n FROM runner_pairings WHERE owner_id=? AND cancelled=0 AND node_id IS NULL AND expires_at>?',
        )
        .get(this.store.actorId, this.now()) as { n: number };
      if (count.n >= 5) throw new DomainError('PAIRING_LIMIT', '请先取消未使用的配对码', 409);
      code = randomBytes(32).toString('base64url');
      const row: PairRow = {
        id: randomUUID(),
        owner_id: this.store.actorId,
        space_id: this.store.spaceId,
        project_id: projectId,
        code_hash: digest(code),
        expires_at: new Date(this.clock() + 10 * 60000).toISOString(),
        cancelled: 0,
        node_id: null,
        created_at: this.now(),
      };
      this.store.db
        .prepare('INSERT INTO runner_pairings VALUES(?,?,?,?,?,?,0,NULL,?)')
        .run(
          row.id,
          row.owner_id,
          row.space_id,
          row.project_id,
          row.code_hash,
          row.expires_at,
          row.created_at,
        );
      return { id: row.id };
    });
    const row = this.store.db
      .prepare('SELECT * FROM runner_pairings WHERE id=?')
      .get(result.id) as PairRow;
    return { ...this.pairingView(row), code }; // Secret returned once, never stored in replay result.
  }
  cancelPairing(id: string, key: string) {
    this.store.permissions.space();
    const row = this.store.db
      .prepare('SELECT * FROM runner_pairings WHERE id=? AND owner_id=? AND space_id=?')
      .get(id, this.store.actorId, this.store.spaceId) as PairRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '配对记录不可访问', 404);
    if (row.node_id)
      throw new DomainError('NODE_ALREADY_PAIRED', '配对已完成，请撤销对应节点', 409);
    return this.store.mutate(`node.pairing.cancel:${id}`, key, {}, () => {
      this.store.db.prepare('UPDATE runner_pairings SET cancelled=1 WHERE id=?').run(id);
      return { cancelled: true };
    });
  }
  private findPair(code: string) {
    const row = this.store.db
      .prepare('SELECT * FROM runner_pairings WHERE code_hash=?')
      .get(digest(nodeSecret(code))) as PairRow | undefined;
    if (!row || row.cancelled || row.expires_at <= this.now() || !this.authorized(row))
      throw new DomainError('PAIRING_INVALID', '配对码不存在、已撤销或已过期', 401);
    return row;
  }
  preview(code: string) {
    const row = this.findPair(code);
    if (row.node_id)
      throw new DomainError('PAIRING_USED', '配对码已使用；已有节点请直接 start', 409);
    return this.pairingView(row);
  }
  pair(input: ReturnType<typeof parsePair>) {
    return this.store.atomic(() => {
      const row = this.findPair(input.code);
      if (row.project_id !== input.projectId)
        throw new DomainError('PAIRING_SCOPE_CHANGED', '项目与本机确认范围不一致', 409);
      const registration = digest(
        canonicalJson({ ...input, code: undefined, nodeToken: undefined }),
      );
      if (row.node_id) {
        const node = this.row(row.node_id);
        if (
          node.token_hash !== digest(input.nodeToken) ||
          node.client_id !== input.clientId ||
          node.registration_hash !== registration ||
          node.revoked_at
        )
          throw new DomainError('PAIRING_USED', '配对码已被使用，不能接管已有节点', 409);
        return { nodeId: node.id, protocol: 1 as const };
      }
      const count = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM runner_nodes WHERE owner_id=? AND revoked_at IS NULL')
        .get(row.owner_id) as { n: number };
      if (count.n >= 20) throw new DomainError('NODE_LIMIT', '已达到本机开发模式的节点上限', 409);
      if (
        this.store.db
          .prepare('SELECT 1 FROM runner_nodes WHERE token_hash=? OR client_id=?')
          .get(digest(input.nodeToken), input.clientId)
      )
        throw new DomainError('NODE_EXISTS', '本机身份已配对，请保留现有配置', 409);
      const id = randomUUID();
      this.store.db
        .prepare(
          `INSERT INTO runner_nodes(id,owner_id,space_id,project_id,token_hash,client_id,registration_hash,name,platform,arch,grants,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          row.owner_id,
          row.space_id,
          row.project_id,
          digest(input.nodeToken),
          input.clientId,
          registration,
          input.name,
          input.platform,
          input.arch,
          JSON.stringify(input.workspaces),
          this.now(),
        );
      this.store.db.prepare('UPDATE runner_pairings SET node_id=? WHERE id=?').run(id, row.id);
      return { nodeId: id, protocol: 1 as const };
    });
  }
  private authenticate(token: string): NodeRow {
    const row = this.store.db
      .prepare('SELECT * FROM runner_nodes WHERE token_hash=?')
      .get(digest(nodeSecret(token))) as NodeRow | undefined;
    if (!row) throw new DomainError('NODE_AUTH_REQUIRED', '节点凭证无效，请重新配对', 401);
    if (row.revoked_at || !this.authorized(row)) {
      if (!row.revoked_at)
        this.store.db
          .prepare('UPDATE runner_nodes SET revoked_at=?,revision=revision+1 WHERE id=?')
          .run(this.now(), row.id);
      throw new DomainError('NODE_REVOKED', '节点或所有者的项目权限已撤销，请停止同步', 401);
    }
    return row;
  }
  /** Device identity for the separate execution protocol, not a user principal. */
  executionConnection(token: string, connectionId: string) {
    const row = this.authenticate(token);
    this.assertConnection(row, connectionId);
    return row;
  }
  /** Revoked tokens may only submit bounded terminal/unknown evidence, never fetch commands. */
  settlementIdentity(token: string) {
    const row = this.store.db
      .prepare('SELECT * FROM runner_nodes WHERE token_hash=?')
      .get(digest(nodeSecret(token))) as NodeRow | undefined;
    if (!row) throw new DomainError('NODE_AUTH_REQUIRED', '节点身份未获确认', 401);
    return { ...row, settlementOnly: !!row.revoked_at || !this.authorized(row) };
  }
  ownedExecutionNode(id: string) {
    const row = this.row(id);
    this.visible(row);
    this.store.permissions.project(row.project_id, 'edit');
    if (row.owner_id !== this.store.actorId)
      throw new DomainError('NODE_OWNER_REQUIRED', '当前只允许节点所有者发起执行', 403);
    if (row.revoked_at || !this.authorized(row))
      throw new DomainError('NODE_REVOKED', '节点授权已撤销', 409);
    return row;
  }
  private handshake(node: NodeRow, connectionId: string): NodeHello {
    return {
      protocol: 1,
      nodeId: node.id,
      projectId: node.project_id,
      projectName: this.labels(node).projectName,
      spaceId: node.space_id,
      ownerName: this.labels(node).ownerName,
      connectionId,
      acknowledgedSequence: node.sequence,
      intervalMs: NODE_INTERVAL_MS,
      leaseMs: NODE_LEASE_MS,
      executionEnabled: false,
    };
  }
  hello(token: string, connectionId: string): NodeHello {
    const node = this.authenticate(token);
    return this.store.atomic(() => {
      if (
        node.server_epoch === this.epoch &&
        node.connection_id !== connectionId &&
        node.lease_until > this.clock() &&
        !node.disconnected
      )
        throw new DomainError(
          'NODE_ALREADY_CONNECTED',
          '已有节点进程持有连接，请先停止它或等待连接过期',
          409,
        );
      this.store.db
        .prepare(
          'UPDATE runner_nodes SET connection_id=?,server_epoch=?,lease_until=?,disconnected=0 WHERE id=?',
        )
        .run(connectionId, this.epoch, this.clock() + NODE_LEASE_MS, node.id);
      return this.handshake(node, connectionId);
    });
  }
  sync(token: string, connectionId: string, sequence: number, snapshot: NodeSnapshot) {
    const node = this.authenticate(token);
    return this.store.atomic(() => {
      this.assertConnection(node, connectionId);
      const ids = (JSON.parse(node.grants) as DirectoryGrant[]).map((w) => w.id).sort();
      if (canonicalJson(ids) !== canonicalJson(snapshot.workspaces.map((w) => w.id).sort()))
        throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '摘要范围与本机配对授权不一致', 409);
      if (
        [snapshot.capturedAt, ...snapshot.workspaces.map((w) => w.capturedAt)].some(
          (t) => Date.parse(t) > this.clock() + 60000,
        )
      )
        throw new DomainError('CLOCK_SKEW', '采集时间超前，请核对本机时钟', 409);
      const hash = digest(canonicalJson(snapshot));
      if (sequence === node.sequence) {
        if (hash !== node.event_hash)
          throw new DomainError(
            'SEQUENCE_CONFLICT',
            '相同序号的事件内容不同，请保留现场并核对',
            409,
          );
      } else if (sequence === node.sequence + 1) {
        this.store.db
          .prepare('UPDATE runner_nodes SET sequence=?,event_hash=?,snapshot=? WHERE id=?')
          .run(sequence, hash, JSON.stringify(snapshot), node.id);
      } else throw new DomainError('SEQUENCE_GAP', '事件序号不连续，不能跳过未确认记录', 409);
      this.store.db
        .prepare('UPDATE runner_nodes SET last_seen_at=?,lease_until=?,disconnected=0 WHERE id=?')
        .run(this.now(), this.clock() + NODE_LEASE_MS, node.id);
      return { acknowledgedSequence: sequence }; // Atomic commit completes before HTTP response/ACK.
    });
  }
  private assertConnection(node: NodeRow, connectionId: string) {
    if (
      node.server_epoch !== this.epoch ||
      node.connection_id !== connectionId ||
      node.disconnected ||
      node.lease_until <= this.clock()
    )
      throw new DomainError('RECONNECT_REQUIRED', '连接已过期或服务已重启，请重新握手', 409);
  }
  goodbye(token: string, connectionId: string) {
    const node = this.authenticate(token);
    this.assertConnection(node, connectionId);
    this.store.db
      .prepare('UPDATE runner_nodes SET disconnected=1,lease_until=0 WHERE id=?')
      .run(node.id);
    return { disconnected: true };
  }
  disconnect(token: string) {
    const node = this.authenticate(token);
    this.revokeRow(node.id);
    return { revoked: true };
  }
  private revokeRow(id: string) {
    this.store.db
      .prepare(
        'UPDATE runner_nodes SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,lease_until=0 WHERE id=?',
      )
      .run(this.now(), id);
  }
  private visible(row: NodeRow) {
    this.store.permissions.space();
    if (row.space_id !== this.store.spaceId)
      throw new DomainError('NOT_FOUND', '节点不存在或不可访问', 404);
    this.store.permissions.project(row.project_id);
  }
  private view(row: NodeRow): RunnerNode {
    this.visible(row);
    const age = row.last_seen_at ? this.clock() - Date.parse(row.last_seen_at) : Infinity;
    const presence = row.revoked_at
      ? 'revoked'
      : !row.last_seen_at
        ? 'paired'
        : row.server_epoch !== this.epoch
          ? 'unknown'
          : row.disconnected || age > NODE_OFFLINE_MS
            ? 'offline'
            : age > NODE_LEASE_MS
              ? 'stale'
              : 'online';
    return {
      id: row.id,
      name: row.name,
      ownerName: this.labels(row).ownerName,
      projectName: this.labels(row).projectName,
      projectId: row.project_id,
      platform: row.platform,
      arch: row.arch,
      createdAt: row.created_at,
      revision: row.revision,
      canRevoke: row.owner_id === this.store.actorId,
      presence,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      acknowledgedSequence: row.sequence,
      workspaces: JSON.parse(row.grants),
      snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
      capabilities: ['git-summary'],
      executionEnabled: false,
    };
  }
  list(): RunnerNode[] {
    this.store.permissions.space();
    return (
      this.store.db
        .prepare(
          'SELECT n.* FROM runner_nodes n JOIN collab_project_members pm ON pm.project_id=n.project_id AND pm.user_id=? WHERE n.space_id=? ORDER BY n.rowid DESC LIMIT 200',
        )
        .all(this.store.actorId, this.store.spaceId) as NodeRow[]
    ).flatMap((row) => {
      try {
        return [this.view(row)];
      } catch {
        return [];
      }
    });
  }
  get(id: string) {
    return this.view(this.row(id));
  }
  revoke(id: string, expectedRevision: number, key: string) {
    const row = this.row(id);
    this.visible(row);
    if (row.owner_id !== this.store.actorId)
      throw new DomainError(
        'FORBIDDEN',
        '只有节点所有者可以撤销节点；项目管理不等于节点控制权',
        403,
      );
    this.store.mutate(`node.revoke:${id}`, key, { expectedRevision }, () => {
      assertRevision(row.revision, expectedRevision);
      if (!row.revoked_at) this.revokeRow(id);
      return { revoked: true };
    });
    return this.get(id);
  }
}
