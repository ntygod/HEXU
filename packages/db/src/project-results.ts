import { DomainError } from '../../contracts/src/index.js';
import {
  PROJECT_RESULT_EXCERPT_LENGTH,
  type ProjectResultListQuery,
  type ProjectResultPage,
  type ProjectResultSummary,
} from '../../contracts/src/project-results.js';
import type { Store } from './store.js';

interface Row {
  rowid: number;
  id: string;
  revisionId: string | null;
  revision: number | null;
  title: string;
  kind: ProjectResultSummary['kind'];
  excerpt: string;
  excerptTruncated: number;
  savedAt: string;
  taskId: string;
  taskShortId: string;
  taskTitle: string;
  taskStatus: ProjectResultSummary['task']['status'];
}

/** Read-only, bounded project cards. No Result/Task bodies leave SQLite. */
export class ProjectResults {
  constructor(readonly store: Store) {}

  list(projectId: string, query: ProjectResultListQuery): ProjectResultPage {
    // Keep permission, cursor and version reads in one snapshot without taking a write lock.
    this.store.db.exec('SAVEPOINT project_results_read');
    try {
      this.store.project(projectId);
      const { db, actorId, spaceId, teamMode } = this.store;
      // Match PermissionService.canTask / preview canReadTask before pagination. Check
      // JSON identity as well as indexed columns: neither may redirect this project read.
      const tables = 'FROM results r JOIN tasks t ON t.id=r.task_id';
      const visibility = teamMode
        ? "(json_extract(t.body,'$.visibility') IS NOT 'private' OR json_extract(t.body,'$.ownerUserId')=?)"
        : "(json_extract(t.body,'$.visibility')='project' OR json_extract(t.body,'$.ownerUserId')=?)";
      const scope = `WHERE t.project_id=? AND t.space_id=?
          AND json_extract(t.body,'$.id')=t.id
          AND json_extract(t.body,'$.spaceId')=t.space_id
          AND json_extract(t.body,'$.projectId')=t.project_id
          AND json_extract(r.body,'$.id')=r.id
          AND json_extract(r.body,'$.taskId')=t.id
          AND ${visibility}
          AND (?=0 OR (
            EXISTS (SELECT 1 FROM collab_memberships m WHERE m.space_id=t.space_id AND m.user_id=?)
            AND EXISTS (SELECT 1 FROM collab_project_members pm
              WHERE pm.project_id=t.project_id AND pm.user_id=?)
          ))`;
      const parameters = [projectId, spaceId, actorId, Number(teamMode), actorId, actorId];
      let cursor: number | null = null;
      if (query.cursor !== null) {
        const anchor = db
          .prepare(`SELECT r.rowid ${tables} ${scope} AND r.id=?`)
          .get(...parameters, query.cursor) as { rowid: number } | undefined;
        if (!anchor) throw new DomainError('NOT_FOUND', '成果游标不存在或不可访问', 404);
        cursor = anchor.rowid;
      }
      // LEFT JOIN deliberately preserves a visible Result with missing current history.
      // Its page reports the problem instead of fabricating a version or hiding a card.
      // SQLite substr/length stop at NUL. Mark that omission explicitly, including a
      // leading NUL, without materializing the remainder in JavaScript.
      const rows = db
        .prepare(
          `SELECT r.rowid,r.id,v.id AS revisionId,v.revision,
            json_extract(v.body,'$.title') AS title,json_extract(v.body,'$.kind') AS kind,
            CASE WHEN instr(json_extract(v.body,'$.body'),char(0)) BETWEEN 1 AND ${PROJECT_RESULT_EXCERPT_LENGTH}
              THEN substr(json_extract(v.body,'$.body'),1,instr(json_extract(v.body,'$.body'),char(0))-1)||char(65533)
              ELSE substr(json_extract(v.body,'$.body'),1,${PROJECT_RESULT_EXCERPT_LENGTH}) END AS excerpt,
            (instr(json_extract(v.body,'$.body'),char(0))>0
              OR length(json_extract(v.body,'$.body'))>${PROJECT_RESULT_EXCERPT_LENGTH}) AS excerptTruncated,
            json_extract(v.body,'$.createdAt') AS savedAt,
            t.id AS taskId,json_extract(t.body,'$.shortId') AS taskShortId,
            json_extract(t.body,'$.title') AS taskTitle,json_extract(t.body,'$.status') AS taskStatus
          ${tables} LEFT JOIN result_revisions v ON v.result_id=r.id
              AND v.revision=json_extract(r.body,'$.revision')
              AND json_extract(v.body,'$.id')=v.id
              AND json_extract(v.body,'$.resultId')=r.id
              AND json_extract(v.body,'$.taskId')=t.id
              AND json_extract(v.body,'$.revision')=v.revision
          ${scope}
            AND (? IS NULL OR r.rowid<?) ORDER BY r.rowid DESC LIMIT ?`,
        )
        .all(...parameters, cursor, cursor, query.limit + 1) as unknown as Row[];
      const items = rows.slice(0, query.limit).map((row): ProjectResultSummary => {
        if (!row.revisionId || row.revision === null)
          throw new DomainError('RESULT_VERSION_MISSING', '当前成果缺少一致的固定版本', 409);
        return {
          id: row.id,
          revisionId: row.revisionId,
          revision: row.revision,
          title: row.title,
          kind: row.kind,
          excerpt: row.excerpt,
          excerptTruncated: row.excerptTruncated === 1,
          savedAt: row.savedAt,
          task: {
            id: row.taskId,
            shortId: row.taskShortId,
            title: row.taskTitle,
            status: row.taskStatus,
          },
        };
      });
      return {
        projectId,
        items,
        nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    } finally {
      this.store.db.exec('RELEASE project_results_read');
    }
  }
}
