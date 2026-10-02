import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  INCOMING_HANDOFF_CURSOR_MAX_LENGTH,
  INCOMING_HANDOFF_ENVIRONMENT_MAX_LENGTH,
  INCOMING_HANDOFF_REMAINING_WORK_MAX_LENGTH,
  INCOMING_HANDOFF_SUMMARY_MAX_LENGTH,
  invalidIncomingHandoffCursor,
  type IncomingHandoffListQuery,
  type IncomingHandoffPage,
  type IncomingHandoffSummary,
} from '../../contracts/src/incoming-handoffs.js';
import type { Store } from './store.js';

interface Cursor {
  v: 1;
  afterId: string;
  scope: string;
}
interface Row {
  id: string;
  taskId: string;
  taskShortId: string;
  taskTitle: string;
  projectId: string;
  senderId: string | null;
  senderName: string | null;
  summary: string;
  remainingWork: string;
  environment: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
const unavailable = () => new DomainError('NOT_FOUND', '接手邀请不存在或不可访问', 404);
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decodeCursor(value: string, scope: string): Cursor {
  if (value.length > INCOMING_HANDOFF_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value))
    throw invalidIncomingHandoffCursor();
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      !cursor ||
      cursor.v !== 1 ||
      typeof cursor.afterId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(cursor.afterId) ||
      cursor.scope !== scope ||
      encodeCursor({ v: 1, afterId: cursor.afterId, scope }) !== value
    )
      throw invalidIncomingHandoffCursor();
    return cursor;
  } catch {
    throw invalidIncomingHandoffCursor();
  }
}

const tables = `FROM handoffs h
  JOIN tasks t ON t.id=h.task_id AND t.space_id=h.space_id
  JOIN projects p ON p.id=t.project_id AND p.space_id=t.space_id`;
// Match current project Task access before projection and pagination. Indexed and
// JSON identities must agree; an old invitation never grants parent access.
const scope = `WHERE h.space_id=? AND h.recipient_id=? AND h.state='offered' AND h.expires_at>?
  AND strftime('%Y-%m-%dT%H:%M:%fZ',h.expires_at)=h.expires_at
  AND json_extract(t.body,'$.visibility')='project'
  AND json_extract(t.body,'$.id')=t.id
  AND json_extract(t.body,'$.spaceId')=t.space_id
  AND json_extract(t.body,'$.projectId')=t.project_id
  AND json_extract(p.body,'$.id')=p.id
  AND json_extract(p.body,'$.spaceId')=p.space_id
  AND json_extract(h.body,'$.id')=h.id
  AND json_extract(h.body,'$.taskId')=t.id
  AND json_extract(h.body,'$.spaceId')=h.space_id
  AND json_extract(h.body,'$.projectId')=p.id
  AND json_extract(h.body,'$.sender.id')=h.sender_id
  AND json_extract(h.body,'$.material.recipient.id')=h.recipient_id
  AND json_extract(h.body,'$.state')=h.state
  AND json_extract(h.body,'$.revision')=h.revision
  AND json_extract(h.body,'$.expiresAt')=h.expires_at
  AND json_type(t.body,'$.shortId')='text' AND json_type(t.body,'$.title')='text'
  AND json_type(h.body,'$.summary')='text' AND json_type(h.body,'$.remainingWork')='text'
  AND json_type(h.body,'$.environment')='text'
  AND json_type(h.body,'$.createdAt')='text' AND json_type(h.body,'$.updatedAt')='text'
  AND length(h.id) BETWEEN 1 AND 100 AND h.id NOT GLOB '*[^A-Za-z0-9_-]*'
  AND length(t.id) BETWEEN 1 AND 100 AND t.id NOT GLOB '*[^A-Za-z0-9_-]*'
  AND length(p.id) BETWEEN 1 AND 100 AND p.id NOT GLOB '*[^A-Za-z0-9_-]*'
  AND EXISTS (SELECT 1 FROM collab_memberships m WHERE m.space_id=t.space_id AND m.user_id=?)
  AND EXISTS (SELECT 1 FROM collab_project_members pm WHERE pm.project_id=p.id AND pm.user_id=?)`;
const projection = `SELECT h.id,h.revision,h.expires_at AS expiresAt,
  t.id AS taskId,p.id AS projectId,
  substr(json_extract(t.body,'$.shortId'),1,100) AS taskShortId,
  substr(json_extract(t.body,'$.title'),1,160) AS taskTitle,
  s.id AS senderId,substr(s.name,1,100) AS senderName,
  substr(json_extract(h.body,'$.summary'),1,${INCOMING_HANDOFF_SUMMARY_MAX_LENGTH}) AS summary,
  substr(json_extract(h.body,'$.remainingWork'),1,${INCOMING_HANDOFF_REMAINING_WORK_MAX_LENGTH}) AS remainingWork,
  substr(json_extract(h.body,'$.environment'),1,${INCOMING_HANDOFF_ENVIRONMENT_MAX_LENGTH}) AS environment,
  substr(json_extract(h.body,'$.createdAt'),1,24) AS createdAt,
  substr(json_extract(h.body,'$.updatedAt'),1,24) AS updatedAt
  ${tables}
  LEFT JOIN collab_people s ON s.id=h.sender_id AND length(s.id) BETWEEN 1 AND 100
    AND s.id NOT GLOB '*[^A-Za-z0-9_-]*'
    AND EXISTS (SELECT 1 FROM collab_memberships sm WHERE sm.space_id=h.space_id AND sm.user_id=s.id)`;

function summary(row: Row): IncomingHandoffSummary {
  return {
    id: row.id,
    task: {
      id: row.taskId,
      shortId: row.taskShortId,
      title: row.taskTitle,
      projectId: row.projectId,
    },
    sender: row.senderId === null ? null : { id: row.senderId, name: row.senderName! },
    summary: row.summary,
    remainingWork: row.remainingWork,
    environment: row.environment,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

/** Read-only recipient discovery. Never enters invitation lifecycle or material stores. */
export class IncomingHandoffQueries {
  constructor(
    readonly store: Store,
    private clock: () => number = Date.now,
  ) {}

  private read<T>(action: (parameters: (string | number)[]) => T): T {
    if (!this.store.teamMode) throw unavailable();
    this.store.db.exec('SAVEPOINT incoming_handoffs_read');
    try {
      const { spaceId, actorId } = this.store;
      const at = new Date(this.clock()).toISOString();
      // The first read pins the snapshot; all parent, sender and anchor reads use it.
      this.store.permissions.space();
      return action([spaceId, actorId, at, actorId, actorId]);
    } finally {
      this.store.db.exec('RELEASE incoming_handoffs_read');
    }
  }

  list(query: IncomingHandoffListQuery): IncomingHandoffPage {
    return this.read((parameters) => {
      const cursorScope = createHash('sha256')
        .update(JSON.stringify(['incoming-handoffs', this.store.spaceId, this.store.actorId]))
        .digest('hex');
      let after: number | null = null;
      if (query.cursor !== null) {
        const cursor = decodeCursor(query.cursor, cursorScope);
        const anchor = this.store.db
          .prepare(`SELECT h.rowid ${tables} ${scope} AND h.id=?`)
          .get(...parameters, cursor.afterId) as { rowid: number } | undefined;
        if (!anchor) throw invalidIncomingHandoffCursor();
        after = anchor.rowid;
      }
      const rows = this.store.db
        .prepare(
          `${projection} ${scope} AND (? IS NULL OR h.rowid<?) ORDER BY h.rowid DESC LIMIT ?`,
        )
        .all(...parameters, after, after, query.limit + 1) as unknown as Row[];
      const items = rows.slice(0, query.limit).map(summary);
      return {
        items,
        nextCursor:
          rows.length > query.limit
            ? encodeCursor({ v: 1, afterId: items.at(-1)!.id, scope: cursorScope })
            : null,
      };
    });
  }

  get(taskId: string, handoffId: string): IncomingHandoffSummary {
    return this.read((parameters) => {
      const row = this.store.db
        .prepare(`${projection} ${scope} AND t.id=? AND h.id=? LIMIT 1`)
        .get(...parameters, taskId, handoffId) as unknown as Row | undefined;
      if (!row) throw unavailable();
      return summary(row);
    });
  }
}
