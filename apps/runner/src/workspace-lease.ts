import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep, resolve, dirname } from 'node:path';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { nodeId } from '../../../packages/contracts/src/nodes.js';
import { canonicalJson } from '../../../packages/domain/src/index.js';
import { constants as F, fstatSync } from 'node:fs';
import { ensurePrivateHome } from './agent/storage.js';

/** Persistent per-OS-user claim shared by preview and independent nodes. A crash
 * does NOT free a possibly live writer. Never signal a PID read from disk. */
export class WorkspaceLease {
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly root: string;
  constructor(
    root: string,
    readonly dispatchId: string,
    recover = false,
  ) {
    const canonical = realpathSync(root),
      stat = statSync(canonical);
    this.root = canonical;
    const within = (parent: string, child: string) => {
      const r = relative(parent, child);
      return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
    };
    const home = ensurePrivateHome(join(homedir(), '.hexu', 'workspace-leases'));
    if (within(canonical, home))
      throw new DomainError(
        'LEASE_INSIDE_WORKSPACE',
        '授权目录不能包含受管工作区锁目录；请使用更小的独立 Git 目录',
      );
    const path = join(home, 'registry.sqlite');
    if (!existsSync(path)) {
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.mode & 0o077 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw new DomainError('INSECURE_LEASE', '工作区锁文件权限无效');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS claims(root TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,identity TEXT NOT NULL); BEGIN IMMEDIATE;',
      );
      const claims = this.db.prepare('SELECT root,dispatch_id,identity FROM claims').all() as {
        root: string;
        dispatch_id: string;
        identity: string;
      }[];
      const overlap = claims.filter(
        (c) =>
          c.identity === `${stat.dev}:${stat.ino}` ||
          within(c.root, canonical) ||
          within(canonical, c.root),
      );
      if (overlap.some((c) => !recover || c.dispatch_id !== dispatchId || c.root !== canonical))
        throw new DomainError(
          'LOCAL_WORKSPACE_BUSY',
          '此目录或重叠目录还有受管执行或未确认旧进程；不会启动第二个写入者',
          409,
        );
      if (!overlap.length && !recover)
        this.db
          .prepare('INSERT INTO claims VALUES(?,?,?)')
          .run(canonical, dispatchId, `${stat.dev}:${stat.ino}`);
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      this.db.close();
      throw e;
    }
  }
  assertHeld() {
    if (this.closed) throw new DomainError('LOCAL_WORKSPACE_BUSY', '工作区写锁已关闭', 409);
    const stat = statSync(this.root);
    const row = this.db
      .prepare('SELECT dispatch_id,identity FROM claims WHERE root=?')
      .get(this.root) as { dispatch_id: string; identity: string } | undefined;
    if (!row || row.dispatch_id !== this.dispatchId || row.identity !== `${stat.dev}:${stat.ino}`)
      throw new DomainError('LOCAL_WORKSPACE_BUSY', '原持久工作区写锁或目录身份已变化', 409);
  }
  release() {
    if (this.closed) return;
    this.db
      .prepare('DELETE FROM claims WHERE root=? AND dispatch_id=?')
      .run(this.root, this.dispatchId);
    this.close();
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}

export interface WorkspaceReleaseRequest {
  version: 1;
  recoveryId: string;
  claimId: string;
  root: string;
  identity: string;
  gitIdentity: string;
  evidenceHash: string;
  stoppedConfirmedAt: string;
}
export interface WorkspaceReleaseReceipt extends WorkspaceReleaseRequest {
  releasedAt: string;
}
const releaseInvalid = () =>
  new DomainError(
    'WORKSPACE_RELEASE_MISMATCH',
    '原目录锁、身份或停止确认收据不一致；没有清除其他占用',
    409,
  );
function validateReleaseRequest(r: WorkspaceReleaseRequest) {
  if (
    !r ||
    typeof r !== 'object' ||
    Object.keys(r).sort().join(',') !==
      [
        'version',
        'recoveryId',
        'claimId',
        'root',
        'identity',
        'gitIdentity',
        'evidenceHash',
        'stoppedConfirmedAt',
      ]
        .sort()
        .join(',') ||
    r.version !== 1 ||
    typeof r.claimId !== 'string' ||
    !r.claimId.startsWith('integration:') ||
    typeof r.root !== 'string' ||
    !isAbsolute(r.root) ||
    resolve(r.root) !== r.root ||
    Buffer.byteLength(r.root) > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(r.root) ||
    typeof r.identity !== 'string' ||
    !/^\d+:\d+$/.test(r.identity) ||
    typeof r.gitIdentity !== 'string' ||
    !/^\d+:\d+$/.test(r.gitIdentity) ||
    typeof r.evidenceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.evidenceHash) ||
    typeof r.stoppedConfirmedAt !== 'string' ||
    !Number.isFinite(Date.parse(r.stoppedConfirmedAt)) ||
    new Date(r.stoppedConfirmedAt).toISOString() !== r.stoppedConfirmedAt
  )
    throw releaseInvalid();
  try {
    nodeId(r.recoveryId);
    nodeId(r.claimId.slice('integration:'.length));
  } catch {
    throw releaseInvalid();
  }
}
function releaseRegistry(root: string) {
  const home = join(homedir(), '.hexu', 'workspace-leases');
  // Do not realpath away a redirected private-state directory before inspecting
  // it. A registry moved into the worktree must never be modified by settlement.
  for (let path = home; ; path = dirname(path)) {
    const value = lstatSync(path);
    if (!value.isDirectory() || value.isSymbolicLink()) throw releaseInvalid();
    if (path === dirname(path)) break;
  }
  if (realpathSync(home) !== home) throw releaseInvalid();
  const path = join(home, 'registry.sqlite'),
    dir = lstatSync(home),
    file = lstatSync(path);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.mode & 0o077 ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.mode & 0o077 ||
    (process.getuid && (file.uid !== process.getuid() || dir.uid !== process.getuid()))
  )
    throw releaseInvalid();
  const r = relative(root, path);
  if (!r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))) throw releaseInvalid();
  return path;
}
/** Existing private registry only; does not initialize it or grant a release. */
export const workspaceClaimRegistryPath = releaseRegistry;
const releaseHash = (r: WorkspaceReleaseRequest) =>
  createHash('sha256').update(canonicalJson(r)).digest('hex');
function recordedRelease(
  db: DatabaseSync,
  request: WorkspaceReleaseRequest,
): WorkspaceReleaseReceipt | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_release_receipts'",
      )
      .get()
  )
    return null;
  const row = db
    .prepare('SELECT request_hash,body FROM workspace_release_receipts WHERE recovery_id=?')
    .get(request.recoveryId) as { request_hash: string; body: string } | undefined;
  if (!row) return null;
  try {
    const receipt = JSON.parse(row.body) as WorkspaceReleaseReceipt;
    const { releasedAt, ...original } = receipt;
    if (
      row.request_hash !== releaseHash(request) ||
      canonicalJson(original) !== canonicalJson(request) ||
      typeof releasedAt !== 'string' ||
      !Number.isFinite(Date.parse(releasedAt)) ||
      new Date(releasedAt).toISOString() !== releasedAt ||
      releasedAt < request.stoppedConfirmedAt
    )
      throw releaseInvalid();
    return receipt;
  } catch {
    throw releaseInvalid();
  }
}
/** Historical receipt only. Does not initialize a registry, inspect a workspace,
 * acquire a writer claim, or interpret a missing claim as a prior release. */
export function workspaceReleaseReceipt(
  request: WorkspaceReleaseRequest,
): WorkspaceReleaseReceipt | null {
  validateReleaseRequest(request);
  let path: string;
  try {
    path = releaseRegistry(request.root);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Match the registry's bounded transaction wait. A short unrelated commit
    // is not evidence that an immutable release receipt is missing or invalid.
    // Timeout still throws; never convert an unreadable registry into no receipt.
    db.exec('PRAGMA busy_timeout=5000');
    return recordedRelease(db, request);
  } finally {
    db.close();
  }
}
/** Caller holds the original application's process guard and explicit stopped
 * confirmation. This records only a preserved-files claim release, not success
 * of any write. Receipt+exact claim deletion commit atomically in this registry. */
export function releaseWorkspaceClaim(request: WorkspaceReleaseRequest): WorkspaceReleaseReceipt {
  validateReleaseRequest(request);
  const old = workspaceReleaseReceipt(request);
  if (old) return old; // Never touch a later writer or a moved/replaced workspace.
  const db = new DatabaseSync(releaseRegistry(request.root));
  let root: number | undefined, git: number | undefined;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    const receipt = recordedRelease(db, request);
    if (receipt) {
      db.exec('COMMIT');
      return receipt;
    }
    if (realpathSync(request.root) !== request.root) throw releaseInvalid();
    root = openSync(request.root, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    git = openSync(`/proc/self/fd/${root}/.git`, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    const identity = (s: { dev: number | bigint; ino: number | bigint }) => `${s.dev}:${s.ino}`;
    const current = () => {
      if (
        identity(fstatSync(root!)) !== request.identity ||
        identity(fstatSync(git!)) !== request.gitIdentity ||
        realpathSync(request.root) !== request.root ||
        identity(lstatSync(request.root)) !== request.identity ||
        !lstatSync(join(request.root, '.git')).isDirectory() ||
        identity(lstatSync(join(request.root, '.git'))) !== request.gitIdentity
      )
        throw releaseInvalid();
    };
    current();
    const inside = (a: string, b: string) => {
      const r = relative(a, b);
      return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
    };
    const claims = db.prepare('SELECT root,dispatch_id,identity FROM claims').all() as {
      root: string;
      dispatch_id: string;
      identity: string;
    }[];
    const overlapping = claims.filter(
      (c) =>
        c.identity === request.identity ||
        inside(c.root, request.root) ||
        inside(request.root, c.root),
    );
    if (
      overlapping.length !== 1 ||
      overlapping[0]!.root !== request.root ||
      overlapping[0]!.dispatch_id !== request.claimId ||
      overlapping[0]!.identity !== request.identity
    )
      throw releaseInvalid();
    if (Date.parse(request.stoppedConfirmedAt) > Date.now())
      throw new DomainError(
        'CLOCK_SKEW',
        '本机时间早于原停止确认；保留原请求和写锁后核对时钟',
        409,
      );
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_release_receipts(recovery_id TEXT PRIMARY KEY,claim_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS workspace_release_immutable_update BEFORE UPDATE ON workspace_release_receipts BEGIN SELECT RAISE(ABORT,'workspace release receipts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS workspace_release_immutable_delete BEFORE DELETE ON workspace_release_receipts BEGIN SELECT RAISE(ABORT,'workspace release receipts are immutable'); END;`);
    const result: WorkspaceReleaseReceipt = { ...request, releasedAt: new Date().toISOString() };
    db.prepare('INSERT INTO workspace_release_receipts VALUES(?,?,?,?)').run(
      request.recoveryId,
      request.claimId,
      releaseHash(request),
      JSON.stringify(result),
    );
    current();
    const removed = db
      .prepare('DELETE FROM claims WHERE root=? AND dispatch_id=? AND identity=?')
      .run(request.root, request.claimId, request.identity);
    if (removed.changes !== 1) throw releaseInvalid();
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    if (cause instanceof DomainError) throw cause;
    throw new DomainError(
      'WORKSPACE_RELEASE_UNKNOWN',
      '原锁结算未获确认；保留原请求，只核对持久收据，不从锁缺失推断成功',
      409,
    );
  } finally {
    if (git !== undefined) closeSync(git);
    if (root !== undefined) closeSync(root);
    db.close();
  }
}
