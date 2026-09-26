import { DatabaseSync } from 'node:sqlite';
import { existsSync, openSync, closeSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../../../packages/contracts/src/index.js';
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
      const claims = this.db.prepare('SELECT root,dispatch_id FROM claims').all() as {
        root: string;
        dispatch_id: string;
      }[];
      const overlap = claims.filter((c) => within(c.root, canonical) || within(canonical, c.root));
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
