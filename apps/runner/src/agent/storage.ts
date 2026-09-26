import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import {
  controlOrigin,
  nodeId,
  nodeSecret,
  parseSnapshot,
  type NodeSnapshot,
} from '../../../../packages/contracts/src/nodes.js';
import type { LocalDirectory } from './workspaces.js';

export interface NodeCredentials {
  version: 1;
  controlUrl: string;
  clientId: string;
  nodeToken: string;
  name: string;
  projectId: string;
  spaceId: string;
  nodeId: string | null;
  directories: LocalDirectory[];
}
export function ensurePrivateHome(path: string) {
  if (process.platform === 'win32')
    throw new DomainError(
      'PLATFORM_UNSUPPORTED',
      '当前节点凭证文件边界只支持 POSIX；Windows 尚未接入',
    );
  const full = resolve(path);
  mkdirSync(full, { recursive: true, mode: 0o700 });
  const s = lstatSync(full);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw new DomainError(
      'INSECURE_STATE_DIRECTORY',
      '节点状态目录必须属于当前用户、不是符号链接且权限为 0700',
    );
  return realpathSync(full);
}
function secureFile(path: string) {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw new DomainError(
      'INSECURE_STATE_FILE',
      '节点状态文件不是当前用户独占的普通文件，请核对 0600 权限',
    );
}
function newFile(path: string) {
  if (existsSync(path)) {
    secureFile(path);
    return;
  }
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
}
export function readCredentials(home: string): NodeCredentials {
  const path = join(home, 'credentials.json');
  if (!existsSync(path)) throw new DomainError('NOT_PAIRED', '此状态目录尚未配对，请先 connect');
  secureFile(path);
  const raw = readFileSync(path, 'utf8');
  if (raw.length > 32768) throw new DomainError('INVALID_STATE', '节点配置过大');
  const v = JSON.parse(raw) as NodeCredentials;
  if (
    v.version !== 1 ||
    !Array.isArray(v.directories) ||
    !v.directories.length ||
    v.directories.length > 8
  )
    throw new DomainError('INVALID_STATE', '节点配置无效，请保留现场后重新配对');
  controlOrigin(v.controlUrl);
  nodeSecret(v.nodeToken);
  nodeId(v.clientId);
  nodeId(v.projectId);
  nodeId(v.spaceId);
  if (v.nodeId) nodeId(v.nodeId);
  for (const w of v.directories) {
    nodeId(w.id);
    if (
      ![w.root, w.rootIdentity, w.gitDir, w.gitIdentity, w.name].every(
        (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096,
      )
    )
      throw new DomainError('INVALID_STATE', '本地授权记录无效');
  }
  return v;
}
export function writeCredentials(home: string, value: NodeCredentials) {
  const target = join(home, 'credentials.json');
  if (existsSync(target)) secureFile(target);
  const temporary = join(home, `.credentials-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  const dir = openSync(home, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function forgetCredentials(home: string) {
  const target = join(home, 'credentials.json');
  if (existsSync(target)) {
    secureFile(target);
    unlinkSync(target);
  }
}

/** A separate SQLite connection holds a process-lifetime OS lock. A crash releases
 * it without signalling a persisted PID. The event journal remains independently transactional. */
export class AgentStorage {
  readonly home: string;
  private guard: DatabaseSync;
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.home = ensurePrivateHome(path);
    const guardPath = join(this.home, 'process-lock.sqlite');
    newFile(guardPath);
    this.guard = new DatabaseSync(guardPath);
    try {
      this.guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch {
      this.guard.close();
      throw new DomainError(
        'RUNNER_ALREADY_STARTED',
        '此节点状态目录已有进程使用，没有启动第二个连接',
      );
    }
    try {
      const journal = join(this.home, 'journal.sqlite');
      newFile(journal);
      this.db = new DatabaseSync(journal);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS cursor(id INTEGER PRIMARY KEY CHECK(id=1),ack INTEGER NOT NULL);
        INSERT OR IGNORE INTO cursor VALUES(1,0);
        CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL,body TEXT NOT NULL);`);
      chmodSync(journal, 0o600);
    } catch (error) {
      this.guard.close();
      throw error;
    }
  }
  resetForPairing() {
    if (existsSync(join(this.home, 'credentials.json')))
      throw new DomainError('ALREADY_PAIRED', '已有配对凭证，不能重置日志');
    this.db.exec(
      'BEGIN IMMEDIATE; DELETE FROM pending; UPDATE cursor SET ack=0 WHERE id=1; COMMIT;',
    );
  }
  acknowledged() {
    return (this.db.prepare('SELECT ack FROM cursor WHERE id=1').get() as { ack: number }).ack;
  }
  pending(): { sequence: number; snapshot: NodeSnapshot } | null {
    const row = this.db.prepare('SELECT sequence,body FROM pending WHERE id=1').get() as
      | { sequence: number; body: string }
      | undefined;
    return row ? { sequence: row.sequence, snapshot: parseSnapshot(JSON.parse(row.body)) } : null;
  }
  reconcile(serverAck: number) {
    const ack = this.acknowledged(),
      pending = this.pending();
    if (!Number.isSafeInteger(serverAck) || (serverAck !== ack && serverAck !== pending?.sequence))
      throw new DomainError(
        'JOURNAL_MISMATCH',
        '服务端与本地 ACK 不一致，可能发生数据回退。没有跳号或覆盖，请核对后重新配对',
      );
  }
  enqueue(snapshot: NodeSnapshot) {
    const pending = this.pending();
    if (pending) return pending; // Bounded one-record spool; never overwrite unacknowledged state.
    const valid = parseSnapshot(snapshot),
      sequence = this.acknowledged() + 1;
    this.db.prepare('INSERT INTO pending VALUES(1,?,?)').run(sequence, JSON.stringify(valid));
    return { sequence, snapshot: valid };
  }
  acknowledge(sequence: number) {
    const pending = this.pending();
    if (!pending || pending.sequence !== sequence)
      throw new DomainError('ACK_MISMATCH', 'ACK 不对应当前待确认记录');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE cursor SET ack=? WHERE id=1').run(sequence);
      this.db.prepare('DELETE FROM pending WHERE id=1').run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
    this.guard.exec('ROLLBACK');
    this.guard.close();
  }
}
