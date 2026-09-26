import type {
  DispatchCommand,
  ExecutionEvent,
} from '../../../../packages/contracts/src/node-execution.js';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { AgentStorage } from './storage.js';

type LocalRow = { id: string; body: string; phase: string };
export class ExecutionJournal {
  constructor(readonly storage: AgentStorage) {
    storage.db
      .exec(`CREATE TABLE IF NOT EXISTS execution_commands(id TEXT PRIMARY KEY, body TEXT NOT NULL, phase TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_events(dispatch_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(dispatch_id,sequence));`);
  }
  pendingSummaries() {
    // No prompt/context, paths, credentials, or inferred PID status in diagnostics.
    return this.commands().flatMap((row) => {
      const pending = Number(
        this.storage.db
          .prepare(
            'SELECT COUNT(*) AS n FROM execution_events WHERE dispatch_id=? AND acknowledged=0',
          )
          .get(row.id)!.n,
      );
      if (row.phase === 'terminal' && !pending) return [];
      const c = JSON.parse(row.body) as DispatchCommand;
      return [
        {
          dispatchId: row.id,
          runId: c.runId,
          taskId: c.taskId,
          workspaceId: c.workspaceId,
          phase: row.phase,
          pendingEvents: pending,
          requiresLocalReview: row.phase !== 'terminal',
        },
      ];
    });
  }
  assertCanDisconnect() {
    if (this.commands().some((c) => c.phase !== 'terminal') || this.pending())
      throw new DomainError(
        'EXECUTION_UNSETTLED',
        '仍有未确认执行或未送达证据。先在本机核对并 recover-execution，再 start 送达证据；不能删除凭证或重新配对绕过占用。',
        409,
      );
  }
  get(id: string) {
    return this.storage.db.prepare('SELECT * FROM execution_commands WHERE id=?').get(id) as
      | LocalRow
      | undefined;
  }
  commands() {
    return this.storage.db.prepare('SELECT * FROM execution_commands').all() as LocalRow[];
  }
  accept(command: DispatchCommand) {
    const old = this.get(command.id);
    if (old) {
      if (canonicalJson(JSON.parse(old.body)) !== canonicalJson(command))
        throw new DomainError('COMMAND_CHANGED', '同一派发内容发生变化，没有启动进程');
      return false;
    }
    this.storage.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.storage.db.prepare("SELECT 1 FROM execution_commands WHERE phase!='terminal'").get())
        throw new DomainError('LOCAL_EXECUTION_BUSY', '还有未确认执行，不能接新任务');
      this.storage.db
        .prepare("INSERT INTO execution_commands VALUES(?,?,'accepted')")
        .run(command.id, JSON.stringify(command));
      this.append(command.id, 'accepted');
      this.storage.db.exec('COMMIT');
    } catch (e) {
      this.storage.db.exec('ROLLBACK');
      throw e;
    }
    return true;
  }
  phase(id: string, phase: string) {
    this.storage.db.prepare('UPDATE execution_commands SET phase=? WHERE id=?').run(phase, id);
  }
  append(
    id: string,
    kind: ExecutionEvent['kind'],
    text = '',
    result: ExecutionEvent['result'] = null,
  ) {
    const seq = Number(
      this.storage.db
        .prepare(
          'SELECT COALESCE(MAX(sequence),0)+1 AS n FROM execution_events WHERE dispatch_id=?',
        )
        .get(id)!.n,
    );
    if (seq > 128) throw new DomainError('LOCAL_EVENT_LIMIT', '本机执行事件超限，停止并保留现场');
    const event: ExecutionEvent = {
      sequence: seq,
      kind,
      text: text.slice(0, 6000),
      result,
      terminationConfirmed: kind === 'terminal',
    };
    this.storage.db
      .prepare('INSERT INTO execution_events(dispatch_id,sequence,body) VALUES(?,?,?)')
      .run(id, seq, JSON.stringify(event));
    return event;
  }
  settle(id: string, result: 'succeeded' | 'failed' | 'cancelled', text: string) {
    if (this.get(id)?.phase === 'terminal') return;
    this.storage.db.exec('BEGIN IMMEDIATE');
    try {
      this.append(id, 'terminal', text, result);
      this.phase(id, 'terminal');
      this.storage.db.exec('COMMIT');
    } catch (e) {
      this.storage.db.exec('ROLLBACK');
      throw e;
    }
  }
  recover() {
    for (const c of this.commands())
      if (!['terminal', 'unknown'].includes(c.phase)) {
        this.storage.db.exec('BEGIN IMMEDIATE');
        try {
          this.phase(c.id, 'unknown');
          this.append(c.id, 'unknown');
          this.storage.db.exec('COMMIT');
        } catch (e) {
          this.storage.db.exec('ROLLBACK');
          throw e;
        }
      }
  }
  pending() {
    const row = this.storage.db
      .prepare(
        'SELECT dispatch_id,sequence,body FROM execution_events WHERE acknowledged=0 ORDER BY rowid LIMIT 1',
      )
      .get() as { dispatch_id: string; sequence: number; body: string } | undefined;
    if (!row) return null;
    return {
      command: JSON.parse(this.get(row.dispatch_id)!.body) as DispatchCommand,
      event: JSON.parse(row.body) as ExecutionEvent,
    };
  }
  acknowledge(id: string, sequence: number) {
    const row = this.pending();
    if (!row || row.command.id !== id || row.event.sequence !== sequence)
      throw new DomainError('ACK_MISMATCH', '执行 ACK 不匹配');
    this.storage.db
      .prepare('UPDATE execution_events SET acknowledged=1 WHERE dispatch_id=? AND sequence=?')
      .run(id, sequence);
  }
}
