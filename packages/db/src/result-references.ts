import { randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseResultReferenceCreate,
  parseResultReferenceLifecycle,
  type ResultReference,
  type ResultReferenceOriginal,
  type ResultReferenceListQuery,
  type ResultReferencePage,
} from '../../contracts/src/result-references.js';
import { assertRevision } from '../../domain/src/index.js';
import { ResultRevisions } from './result-revisions.js';
import type { Store } from './store.js';

interface Row {
  body: string;
  revision: number;
  status: ResultReference['status'];
  withdrawn_at: string | null;
  withdrawn_by: string | null;
}
const decode = (row: Row): ResultReference => ({
  ...(JSON.parse(row.body) as ResultReferenceOriginal),
  revision: row.revision,
  status: row.status,
  withdrawnAt: row.withdrawn_at,
  withdrawnBy: row.withdrawn_by ? JSON.parse(row.withdrawn_by) : null,
});

/** Manual metadata only. Never fetches, deploys, or modifies the referenced version. */
export class ResultReferences {
  constructor(readonly store: Store) {}

  private source(resultId: string, revisionId: string, write = false) {
    const result = this.store.result(resultId);
    const task = this.store.getTask(result.taskId, write);
    const version = new ResultRevisions(this.store).get(resultId, revisionId);
    if (version.id !== revisionId || version.resultId !== result.id || version.taskId !== task.id)
      throw new DomainError('NOT_FOUND', '成果版本不存在或不属于此任务', 404);
    return { task, version };
  }

  get(resultId: string, revisionId: string, id: string, write = false): ResultReference {
    const { task } = this.source(resultId, revisionId, write);
    const row = this.store.db
      .prepare(
        `SELECT body,revision,status,withdrawn_at,withdrawn_by FROM result_references
       WHERE id=? AND task_id=? AND result_id=? AND result_revision_id=?`,
      )
      .get(id, task.id, resultId, revisionId) as unknown as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '关联不存在或不属于此固定版本', 404);
    return decode(row);
  }

  list(resultId: string, revisionId: string, query: ResultReferenceListQuery): ResultReferencePage {
    const { task } = this.source(resultId, revisionId);
    let cursor: number | null = null;
    if (query.cursor) {
      this.get(resultId, revisionId, query.cursor);
      cursor = (
        this.store.db
          .prepare('SELECT rowid FROM result_references WHERE id=?')
          .get(query.cursor) as { rowid: number }
      ).rowid;
    }
    const rows = this.store.db
      .prepare(
        `SELECT body,revision,status,withdrawn_at,withdrawn_by FROM result_references
       WHERE task_id=? AND result_id=? AND result_revision_id=? AND (? IS NULL OR rowid<?)
       ORDER BY rowid DESC LIMIT ?`,
      )
      .all(task.id, resultId, revisionId, cursor, cursor, query.limit + 1) as unknown as Row[];
    const items = rows.slice(0, query.limit).map(decode);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }

  private record(reference: ResultReference, action: 'registered' | 'withdrawn') {
    const at = reference.withdrawnAt ?? reference.createdAt;
    this.store.db
      .prepare(
        'INSERT INTO result_reference_events(reference_id,revision,action,body) VALUES(?,?,?,?)',
      )
      .run(reference.id, reference.revision, action, JSON.stringify(reference));
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(reference.taskId, `result.reference_${action}`, at, this.store.spaceId);
  }

  create(resultId: string, revisionId: string, value: unknown, key: string): ResultReference {
    let source = this.source(resultId, revisionId, true);
    const input = parseResultReferenceCreate(value);
    return this.store.mutate(
      `result.reference.register:${revisionId}`,
      key,
      { resultId, revisionId, ...input },
      () => {
        const original: ResultReferenceOriginal = {
          id: randomUUID(),
          taskId: source.task.id,
          resultId,
          resultRevisionId: revisionId,
          resultRevision: source.version.revision,
          kind: input.kind,
          title: input.title,
          url: input.url,
          environment: input.environment ?? '',
          source: {
            kind: 'member',
            actor: { id: this.store.actorId, name: this.store.actorName() },
          },
          createdAt: new Date().toISOString(),
          availability: 'unverified',
          publication: 'unverified',
        };
        this.store.db
          .prepare(
            `INSERT INTO result_references(id,task_id,result_id,result_revision_id,body,revision,status)
           VALUES(?,?,?,?,?,1,'active')`,
          )
          .run(original.id, original.taskId, resultId, revisionId, JSON.stringify(original));
        const reference: ResultReference = {
          ...original,
          revision: 1,
          status: 'active',
          withdrawnAt: null,
          withdrawnBy: null,
        };
        this.record(reference, 'registered');
        return reference;
      },
      () => {
        source = this.source(resultId, revisionId, true);
        assertRevision(source.version.revision, input.expectedResultRevision);
      },
      // The original receipt identifies the registration; its present status may only advance.
      (saved) => this.get(resultId, revisionId, saved.id, true),
    );
  }

  lifecycle(
    resultId: string,
    revisionId: string,
    id: string,
    value: unknown,
    key: string,
  ): ResultReference {
    this.get(resultId, revisionId, id, true);
    const input = parseResultReferenceLifecycle(value);
    return this.store.mutate(
      `result.reference.withdraw:${id}`,
      key,
      { resultId, revisionId, id, ...input },
      () => {
        const current = this.get(resultId, revisionId, id, true);
        assertRevision(current.revision, input.expectedRevision);
        if (current.status === 'withdrawn')
          throw new DomainError('REFERENCE_WITHDRAWN', '此关联已撤回，请重新登记正确链接', 409);
        const reference: ResultReference = {
          ...current,
          revision: current.revision + 1,
          status: 'withdrawn',
          withdrawnAt: new Date().toISOString(),
          withdrawnBy: { id: this.store.actorId, name: this.store.actorName() },
        };
        this.store.db
          .prepare(
            `UPDATE result_references SET revision=?,status=?,withdrawn_at=?,withdrawn_by=? WHERE id=?`,
          )
          .run(
            reference.revision,
            reference.status,
            reference.withdrawnAt,
            JSON.stringify(reference.withdrawnBy),
            id,
          );
        this.record(reference, 'withdrawn');
        return reference;
      },
      () => {
        const current = this.get(resultId, revisionId, id, true);
        assertRevision(current.resultRevision, input.expectedResultRevision);
      },
      (saved) => this.get(resultId, revisionId, saved.id, true),
    );
  }
}
