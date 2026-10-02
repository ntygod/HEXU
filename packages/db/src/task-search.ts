import { createHash } from 'node:crypto';
import type { Task } from '../../contracts/src/index.js';
import {
  invalidTaskSearchCursor,
  TASK_SEARCH_CURSOR_MAX_LENGTH,
  TASK_SEARCH_PAGE_SIZE,
  type TaskSearchPage,
  type TaskSearchQuery,
} from '../../contracts/src/task-search.js';
import { canReadTask } from '../../domain/src/index.js';
import { matchesTaskSearch, normalizeTaskSearch } from '../../domain/src/task-search.js';
import type { Store } from './store.js';

interface Cursor {
  v: 1;
  afterTaskId: string;
  fingerprint: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string, fingerprint: string): Cursor {
  if (value.length > TASK_SEARCH_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value))
    throw invalidTaskSearchCursor();
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      !cursor ||
      cursor.v !== 1 ||
      typeof cursor.afterTaskId !== 'string' ||
      !cursor.afterTaskId ||
      cursor.afterTaskId.length > 100 ||
      cursor.afterTaskId !== cursor.afterTaskId.trim() ||
      cursor.fingerprint !== fingerprint ||
      // Canonical encoding also rejects extra/duplicate keys and invalid UTF-8.
      encodeCursor({ v: 1, afterTaskId: cursor.afterTaskId, fingerprint }) !== value
    )
      throw invalidTaskSearchCursor();
    return cursor;
  } catch {
    throw invalidTaskSearchCursor();
  }
}

/** Literal JavaScript matching after current permissions, with bounded retained rows. */
export class TaskSearch {
  constructor(readonly store: Store) {}

  list(query: TaskSearchQuery): TaskSearchPage {
    // Match the existing read-only savepoint pattern. Permissions, anchor and
    // candidates belong to one snapshot without changing global transactions.
    this.store.db.exec('SAVEPOINT task_search_read');
    try {
      const { db, actorId, spaceId, teamMode } = this.store;
      const q = normalizeTaskSearch(query.q);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([q, teamMode ? 'team-local' : 'local-preview', actorId, spaceId]))
        .digest('hex');
      const readable = (task: Task) =>
        teamMode ? this.store.permissions.canTask(task) : canReadTask(task, actorId, spaceId);
      let after: number | null = null;
      if (query.cursor !== null) {
        const cursor = decodeCursor(query.cursor, fingerprint);
        const anchor = db
          .prepare('SELECT rowid,body FROM tasks WHERE id=? AND space_id=?')
          .get(cursor.afterTaskId, spaceId) as { rowid: number; body: string } | undefined;
        if (!anchor) throw invalidTaskSearchCursor();
        const task = JSON.parse(anchor.body) as Task;
        if (!readable(task) || !matchesTaskSearch(task, q)) throw invalidTaskSearchCursor();
        after = anchor.rowid;
      }
      const items: Task[] = [];
      const candidates = db
        .prepare(
          'SELECT body FROM tasks WHERE space_id=? AND (? IS NULL OR rowid<?) ORDER BY rowid DESC',
        )
        .iterate(spaceId, after, after);
      for (const row of candidates) {
        const task = JSON.parse(row.body as string) as Task;
        if (!readable(task) || !matchesTaskSearch(task, q)) continue;
        if (items.length === TASK_SEARCH_PAGE_SIZE)
          return {
            items,
            nextCursor: encodeCursor({ v: 1, afterTaskId: items.at(-1)!.id, fingerprint }),
          };
        items.push(task);
      }
      return { items, nextCursor: null };
    } finally {
      this.store.db.exec('RELEASE task_search_read');
    }
  }
}
