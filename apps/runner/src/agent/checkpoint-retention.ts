import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { checkpointHash, commitOid } from '../../../../packages/contracts/src/checkpoints.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  RETENTION_LIMITS as limits,
  parseRetentionManifest,
  parseRetentionReport,
  retentionDate,
  type RetentionManifest,
  type RetentionTicket,
  type RetentionView,
  type RetentionReport,
} from '../../../../packages/contracts/src/checkpoint-retention.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  AgentStorage,
  ensurePrivateHome,
  readCredentials,
  type NodeCredentials,
} from './storage.js';
import { captureCommitReference } from './checkpoints.js';
import { verifySnapshot, type SnapshotObject, type ObjectType } from './checkpoint-objects.js';
import { nodeRequest } from './connection.js';
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const safe = (v: string) => v.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};
const bindingFor = (c: NodeCredentials) =>
  digest([
    'retention-v1',
    c.controlUrl,
    c.nodeId,
    c.clientId,
    c.nodeToken,
    c.spaceId,
    c.projectId,
    c.directories,
  ]);
type Packet = ReturnType<typeof parseRetentionReport>;
interface BundleRow {
  id: string;
  binding: string;
  ticket: string;
  manifest: string;
  status: string;
  sequence: number;
  published: number;
  pending: string | null;
}

/** Private bounded object vault, separate from the active Runner's process guard.
 * Raw tree names never become paths. SQLite commits bytes/manifest/outgoing evidence atomically. */
export class RetentionVault {
  readonly storage: AgentStorage;
  constructor(home: string) {
    this.storage = new AgentStorage(join(home, 'retained-checkpoints'));
    this.storage.db.exec(`PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS bundles(id TEXT PRIMARY KEY,binding TEXT NOT NULL,ticket TEXT NOT NULL,manifest TEXT NOT NULL,status TEXT NOT NULL,sequence INTEGER NOT NULL,published INTEGER NOT NULL,pending TEXT);
      CREATE TABLE IF NOT EXISTS objects(bundle_id TEXT NOT NULL,oid TEXT NOT NULL,type TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(bundle_id,oid));`);
  }
  get db() {
    return this.storage.db;
  }
  close() {
    this.storage.close();
  }
  row(id: string) {
    return this.db.prepare('SELECT * FROM bundles WHERE id=?').get(id) as unknown as
      | BundleRow
      | undefined;
  }
  atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }
  save(t: RetentionTicket, m: RetentionManifest, objects: SnapshotObject[], binding: string) {
    parseRetentionManifest(m);
    this.atomic(() => {
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM bundles WHERE status!='deleted'")
        .get() as { n: number };
      const history = this.db.prepare('SELECT COUNT(*) AS n FROM bundles').get() as { n: number };
      if (count.n >= limits.records || history.n >= 1000)
        throw new DomainError('RETENTION_LIMIT', '本机保留容量已满，请明确删除不再需要的副本');
      this.db
        .prepare("INSERT INTO bundles VALUES(?,?,?,?,'retained',0,0,NULL)")
        .run(t.id, binding, JSON.stringify(t), JSON.stringify(m));
      for (const o of objects)
        this.db.prepare('INSERT INTO objects VALUES(?,?,?,?)').run(t.id, o.id, o.type, o.data);
    });
  }
  async verify(id: string): Promise<'verified' | 'missing' | 'corrupt'> {
    const row = this.row(id);
    if (!row || row.status === 'deleted') return 'missing';
    try {
      const m = parseRetentionManifest(JSON.parse(row.manifest));
      const count = this.db
        .prepare(
          'SELECT COUNT(*) AS n,COALESCE(SUM(length(data)),0) AS bytes FROM objects WHERE bundle_id=?',
        )
        .get(id) as { n: number; bytes: number };
      if (count.n < m.coverage.objects) return 'missing';
      if (count.n !== m.coverage.objects || count.bytes !== m.coverage.bytes) return 'corrupt';
      const result = await verifySnapshot(
        m.objectFormat,
        m.commit,
        m.tree,
        async (oid, type, max) => {
          const meta = this.db
            .prepare('SELECT type,length(data) AS size FROM objects WHERE bundle_id=? AND oid=?')
            .get(id, oid) as { type: ObjectType; size: number } | undefined;
          if (!meta || meta.type !== type || meta.size > max) throw new Error('Object unavailable');
          const object = this.db
            .prepare('SELECT data FROM objects WHERE bundle_id=? AND oid=?')
            .get(id, oid) as { data: Uint8Array };
          return Buffer.from(object.data);
        },
      );
      return result.snapshotHash === m.snapshotHash &&
        canonicalJson(result.coverage) === canonicalJson(m.coverage)
        ? 'verified'
        : 'corrupt';
    } catch {
      return 'corrupt';
    }
  }
  enqueue(id: string, report: RetentionReport): Packet {
    const r = this.row(id)!;
    if (r.pending) return parseRetentionReport(JSON.parse(r.pending));
    if (r.status === 'deleted')
      throw new DomainError('RETENTION_DELETED', '本机副本已删除，不能复活');
    const t = JSON.parse(r.ticket) as RetentionTicket;
    const packet = parseRetentionReport({
      requestId: id,
      requestHash: t.requestHash,
      sequence: r.sequence + 1,
      report,
      confirmPublication: true,
    });
    this.db
      .prepare('UPDATE bundles SET pending=?,sequence=?,status=? WHERE id=?')
      .run(
        JSON.stringify(packet),
        packet.sequence,
        report.state === 'verified' ? 'retained' : report.state,
        id,
      );
    return packet;
  }
  forget(id: string, published: boolean) {
    return this.atomic(() => {
      const r = this.row(id)!;
      if (r.pending) throw new DomainError('RETENTION_PENDING', '先确认已有发布回执，再删除副本');
      let packet: Packet | null = null;
      if (published)
        packet = this.enqueue(id, { state: 'deleted', observedAt: new Date().toISOString() });
      this.db.prepare('DELETE FROM objects WHERE bundle_id=?').run(id);
      this.db.prepare("UPDATE bundles SET status='deleted' WHERE id=?").run(id);
      return packet;
    });
  }
}
function validateView(v: RetentionView, id: string, c: NodeCredentials) {
  const t = v?.request;
  if (
    !t ||
    t.id !== id ||
    t.nodeId !== c.nodeId ||
    t.projectId !== c.projectId ||
    t.spaceId !== c.spaceId ||
    !c.directories.some((w) => w.id === t.workspaceId) ||
    ![1, 7, 30].includes(t.days) ||
    !['sha1', 'sha256'].includes(t.objectFormat) ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 0 ||
    v.sequence > 100 ||
    ![
      'pending',
      'cancelled',
      'expired',
      'invalidated',
      'retained',
      'missing',
      'corrupt',
      'deleted',
    ].includes(v.state)
  )
    throw new DomainError('CHECKPOINT_MISMATCH', '保留请求不属于当前本机节点或格式无效');
  nodeId(t.checkpointId);
  nodeId(t.taskId);
  checkpointHash(t.requestHash);
  checkpointHash(t.repositoryIdentity);
  commitOid(t.commit, t.objectFormat);
  commitOid(t.tree, t.objectFormat);
  retentionDate(t.createdAt);
  retentionDate(t.expiresAt);
  if (v.manifest) parseRetentionManifest(v.manifest);
  return v;
}
export async function localRetentionOperation(
  home: string,
  id: string,
  mode: 'retain' | 'verify' | 'forget',
  ask: (p: string) => Promise<string>,
  log: (m: string) => void = console.log,
) {
  nodeId(id);
  home = ensurePrivateHome(home);
  const c = readCredentials(home),
    binding = bindingFor(c);
  if (!c.nodeId) throw new DomainError('NOT_PAIRED', '请先完成本机配对');
  // Check every paired source before creating a vault: metadata must never land in source code/Git storage.
  if (c.directories.some((w) => [w.root, w.gitDir].some((p) => inside(p, home) || inside(home, p))))
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '保留状态目录与授权仓库重叠，未写入');
  const stillBound = () => {
    if (bindingFor(readCredentials(home)) !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机凭证或目录配置已变化，未继续操作');
  };
  const vault = new RetentionVault(home);
  try {
    let row = vault.row(id);
    if (row && row.binding !== binding)
      throw new DomainError(
        'CHECKPOINT_SCOPE_CHANGED',
        '保留记录属于原本机凭证，不借新身份读取或发布',
      );
    let view: RetentionView | null = null;
    try {
      view = validateView(
        await nodeRequest<RetentionView>(
          c.controlUrl,
          'checkpoint-retention-inspect',
          { requestId: id },
          c.nodeToken,
        ),
        id,
        c,
      );
    } catch (cause) {
      if (mode !== 'forget' || !row || row.pending) throw cause;
      log('无法核对远端状态；只允许明确删除本机副本，结果回执另行确认。');
    }
    stillBound();
    if (
      row &&
      view &&
      view.request.requestHash !== (JSON.parse(row.ticket) as RetentionTicket).requestHash
    )
      throw new DomainError('CHECKPOINT_MISMATCH', '原保留请求变化，保留本机记录');
    async function publish(packet: Packet) {
      stillBound();
      const receipt = validateView(
        await nodeRequest<RetentionView>(
          c.controlUrl,
          'checkpoint-retention-report',
          packet,
          c.nodeToken,
        ),
        id,
        c,
      );
      if (
        receipt.sequence !== packet.sequence ||
        receipt.request.requestHash !== packet.requestHash ||
        (packet.report.state === 'retained' &&
          receipt.manifest?.snapshotHash !== packet.report.manifest.snapshotHash)
      )
        throw new DomainError('INVALID_RESPONSE', '未确认同一保留结果，原回执仍在本机');
      vault.db.prepare('UPDATE bundles SET pending=NULL,published=1 WHERE id=?').run(id);
      return receipt;
    }
    if (row?.pending) {
      if (view && !view.manifest && view.state !== 'pending') {
        vault.db.prepare('UPDATE bundles SET pending=NULL WHERE id=?').run(id);
        row = vault.row(id);
        if (mode !== 'forget')
          throw new DomainError(
            'CHECKPOINT_REQUEST_CLOSED',
            '请求未发布且已关闭；本机副本保留，请明确删除',
          );
      } else {
        log('确认上次固定结果，不重新采集、不续期，也不执行本次其他动作。');
        return await publish(parseRetentionReport(JSON.parse(row.pending)));
      }
    }
    if (mode === 'forget') {
      if (!row) throw new DomainError('NOT_FOUND', '没有对应的本机副本');
      if (row.status === 'deleted')
        return {
          requestId: id,
          localState: 'deleted',
          publication: row.published ? 'confirmed' : 'not_recorded',
        };
      log('仅删除此份保留对象，不删除原仓库、任务记录或其他检查点；过期不会自动删除。');
      if ((await ask(`输入 DELETE ${id}：`)) !== `DELETE ${id}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '已取消删除');
      stillBound();
      const packet = vault.forget(id, !!row.published);
      log('本机保留对象已删除；原代码和检查点历史不变。');
      return packet
        ? await publish(packet)
        : { requestId: id, localState: 'deleted', publication: 'not_recorded' };
    }
    if (!view) throw new DomainError('NODE_AUTH_REQUIRED', '当前节点不可确认');
    if (!row) {
      if (mode !== 'retain') throw new DomainError('NOT_FOUND', '本机没有该保留副本，未重新采集');
      const t = view.request;
      if (view.state !== 'pending' || view.manifest || t.expiresAt <= new Date().toISOString())
        throw new DomainError('CHECKPOINT_REQUEST_CLOSED', '请求已结束，不重新采集或创建副本');
      const w = c.directories.find((w) => w.id === t.workspaceId)!;
      log(`本机目录：${safe(w.root)} · 提交 ${t.commit} · 保留 ${t.days} 天`);
      log(
        '会读取并在私有本机数据库复制此提交的树/文件对象，包括已提交的敏感内容；不会上传代码、文件名、路径或作者邮箱。',
      );
      log(
        '不保留祖先历史、未提交/暂存/未跟踪/忽略内容；LFS 只留指针，子模块只留引用，符号链接不展开；不会下载、切分支或恢复文件。',
      );
      if ((await ask(`输入 RETAIN ${t.commit} ${t.days}：`)) !== `RETAIN ${t.commit} ${t.days}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '已取消本机保留');
      stillBound();
      const confirmed = validateView(
        await nodeRequest<RetentionView>(
          c.controlUrl,
          'checkpoint-retention-inspect',
          { requestId: id },
          c.nodeToken,
        ),
        id,
        c,
      );
      if (confirmed.state !== 'pending' || confirmed.request.requestHash !== t.requestHash)
        throw new DomainError('CHECKPOINT_REQUEST_CLOSED', '确认期间请求已失效，未读取对象');
      let snapshot: Awaited<ReturnType<typeof verifySnapshot>> | undefined;
      const reference = await captureCommitReference(
        w,
        t.commit,
        c.clientId,
        home,
        async (read, _commit, tree) => {
          snapshot = await verifySnapshot(t.objectFormat, t.commit, tree, read);
        },
      );
      if (
        !snapshot ||
        reference.tree !== t.tree ||
        reference.repositoryIdentity !== t.repositoryIdentity
      )
        throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '本机对象库或原引用身份已变化，未保留');
      stillBound();
      // Recheck current server permission and cancellation after the potentially long object walk.
      const current = validateView(
        await nodeRequest<RetentionView>(
          c.controlUrl,
          'checkpoint-retention-inspect',
          { requestId: id },
          c.nodeToken,
        ),
        id,
        c,
      );
      if (current.state !== 'pending' || current.request.requestHash !== t.requestHash)
        throw new DomainError('CHECKPOINT_REQUEST_CLOSED', '核验期间请求失效，未保存对象');
      const retainedAt = new Date().toISOString();
      const manifest = parseRetentionManifest({
        version: 1,
        kind: 'git_snapshot_objects',
        objectFormat: t.objectFormat,
        commit: t.commit,
        tree: t.tree,
        repositoryIdentity: t.repositoryIdentity,
        snapshotHash: snapshot.snapshotHash,
        coverage: snapshot.coverage,
        scope: 'commit_snapshot_without_ancestors_or_external_content',
        retainedAt,
        expiresAt: new Date(Date.parse(retainedAt) + t.days * 86400000).toISOString(),
      });
      stillBound();
      vault.save(t, manifest, snapshot.objects, binding);
      row = vault.row(id)!;
    }
    if (row.status === 'deleted')
      throw new DomainError('RETENTION_DELETED', '本机副本已删除，不重新采集或复活');
    if (row.published && mode === 'retain') return view; // Explicit repeat is a read, never a new capture.
    const state = await vault.verify(id);
    stillBound();
    if (!row.published) {
      if (state !== 'verified')
        throw new DomainError(
          'SNAPSHOT_INCOMPLETE',
          '本机持久副本核验失败，未发布；请明确删除后重新发起',
        );
      const manifest = parseRetentionManifest(JSON.parse(row.manifest));
      return await publish(
        vault.enqueue(id, { state: 'retained', observedAt: manifest.retainedAt, manifest }),
      );
    }
    return await publish(vault.enqueue(id, { state, observedAt: new Date().toISOString() }));
  } finally {
    vault.close();
  }
}
export async function retentionCommand(
  home: string,
  id: string,
  mode: 'retain' | 'verify' | 'forget',
) {
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    const result = await localRetentionOperation(home, id, mode, async (prompt) => {
      process.stdout.write(prompt);
      const next = await iterator.next();
      if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '没有完成本机确认');
      return next.value;
    });
    console.log(JSON.stringify(result));
  } finally {
    lines.close();
  }
}
