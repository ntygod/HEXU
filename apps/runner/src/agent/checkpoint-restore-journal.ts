import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { AgentStorage, readCredentials } from './storage.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import type { buildRestorePlan } from './checkpoint-restore-plan.js';
import type { OwnedRestoreEntry } from './checkpoint-restore-files.js';

export type RestorePlan = Awaited<ReturnType<typeof buildRestorePlan>>;
export interface RestoreProgress {
  id: string;
  requestId: string;
  sourceKind?: 'transfer';
  transferId?: string;
  target: string;
  state:
    | 'preparing'
    | 'writing'
    | 'verified'
    | 'publishing'
    | 'restored'
    | 'cancelled'
    | 'failed'
    | 'interrupted';
  materialState: 'none' | 'staging' | 'published' | 'unknown';
  cleanup: 'not_needed' | 'retained' | 'cleaning' | 'cleaned' | 'needs_attention';
  stageName: string;
  stageIdentity: string | null;
  completedFiles: number;
  writtenBytes: number;
  totalFiles: number;
  totalBytes: number;
  errorCode: string | null;
  updatedAt: string;
  verifiedAt?: string;
}
interface Row {
  id: string;
  target: string;
  binding: string;
  plan: string;
  progress: string;
}
export function restoreProgressFromRow(row: Row): RestoreProgress {
  const p = JSON.parse(row.progress) as RestoreProgress;
  nodeId(row.id);
  if (p.id !== row.id || p.target !== row.target || p.stageName !== `.hexu-restore-${row.id}`)
    throw new DomainError(
      'RESTORE_JOURNAL_INVALID',
      '恢复记录身份或暂存名称不一致，不能自动修复或清理',
    );
  return p;
}
const terminal = new Set<RestoreProgress['state']>([
  'restored',
  'cancelled',
  'failed',
  'interrupted',
]);
export class RestoreJournal {
  readonly storage: AgentStorage;
  constructor(home: string) {
    this.storage = new AgentStorage(join(home, 'checkpoint-restores'));
    try {
      this.storage.db.exec(`
        CREATE TABLE IF NOT EXISTS restores(id TEXT PRIMARY KEY,target TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,plan TEXT NOT NULL,progress TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS restore_entries(attempt_id TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(attempt_id,path));
      `);
      // Acquiring the process guard proves no previous writer is still using this
      // journal. Record interruption only; never resume I/O or infer publication.
      for (const r of this.storage.db.prepare('SELECT * FROM restores').all() as unknown as Row[]) {
        const p = restoreProgressFromRow(r);
        if (!terminal.has(p.state) || p.cleanup === 'cleaning') {
          p.state = 'interrupted';
          p.materialState = 'unknown';
          p.cleanup = 'needs_attention';
          p.errorCode = 'RESTORE_INTERRUPTED';
          this.save(p);
        }
      }
    } catch (cause) {
      this.storage.close();
      throw cause;
    }
  }
  row(target: string) {
    return this.storage.db
      .prepare('SELECT * FROM restores WHERE target=?')
      .get(target) as unknown as Row | undefined;
  }
  begin(plan: RestorePlan, binding: string): RestoreProgress {
    const count = this.storage.db.prepare('SELECT COUNT(*) AS n FROM restores').get() as {
      n: number;
    };
    if (count.n >= 1000)
      throw new DomainError('RESTORE_LIMIT', '本机恢复记录已达上限，请保留日志后进行本机维护');
    const id = randomUUID();
    const p: RestoreProgress = {
      id,
      requestId: plan.source.requestId,
      ...(plan.source.kind === 'transfer'
        ? { sourceKind: 'transfer' as const, transferId: plan.source.requestId }
        : {}),
      target: plan.target.path,
      state: 'preparing',
      materialState: 'none',
      cleanup: 'not_needed',
      stageName: `.hexu-restore-${id}`,
      stageIdentity: null,
      completedFiles: 0,
      writtenBytes: 0,
      totalFiles: plan.entries.filter((e) => e.kind === 'file').length,
      totalBytes: plan.materializedBytes,
      errorCode: null,
      updatedAt: new Date().toISOString(),
    };
    this.storage.db
      .prepare('INSERT INTO restores VALUES(?,?,?,?,?)')
      .run(id, p.target, binding, JSON.stringify(plan), JSON.stringify(p));
    return p;
  }
  save(p: RestoreProgress) {
    p.updatedAt = new Date().toISOString();
    this.storage.db
      .prepare('UPDATE restores SET progress=? WHERE id=?')
      .run(JSON.stringify(p), p.id);
  }
  track(id: string, entry: OwnedRestoreEntry) {
    this.storage.db
      .prepare(
        'INSERT INTO restore_entries VALUES(?,?,?) ON CONFLICT(attempt_id,path) DO UPDATE SET body=excluded.body',
      )
      .run(id, entry.path, JSON.stringify(entry));
  }
  entries(id: string) {
    const rows = this.storage.db
      .prepare('SELECT body FROM restore_entries WHERE attempt_id=?')
      .all(id) as { body: string }[];
    return new Map(
      rows.map((r) => {
        const e = JSON.parse(r.body) as OwnedRestoreEntry;
        return [e.path, e];
      }),
    );
  }
  untrack(id: string, path: string) {
    this.storage.db
      .prepare('DELETE FROM restore_entries WHERE attempt_id=? AND path=?')
      .run(id, path);
  }
  close() {
    this.storage.close();
  }
}

/** Local evidence stays readable under the original local identity even when
 * the server is offline/revoked. It is not a new restore permission or a live
 * assertion about files. This reader neither initializes nor acquires the writer guard. */
export function readRestoreProgress(home: string, target: string): RestoreProgress | null {
  home = resolve(home);
  restorePrivatePath(home, true);
  const binding = restoreBinding(readCredentials(home));
  const dir = join(home, 'checkpoint-restores');
  try {
    restorePrivatePath(dir, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const path = join(dir, 'journal.sqlite');
  restorePrivatePath(path, false);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM restores WHERE target=?').get(target) as unknown as
      | Row
      | undefined;
    if (!row) return null;
    if (row.binding !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '记录属于原本机身份，不能借新凭证读取');
    return restoreProgressFromRow(row);
  } finally {
    db.close();
  }
}
