import { randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseAddResultReference,
  parseRemoveResultReference,
  RESULT_REFERENCE_LIMIT,
  type ResultReference,
  type ResultReferenceList,
} from '../../contracts/src/result-references.js';
import { ResultRevisions } from './result-revisions.js';
import type { Store } from './store.js';

/** Manual associations are separate from immutable ResultRevision snapshots. */
export class ResultReferences {
  constructor(readonly store: Store) {}

  private parent(resultId: string, revisionId: string, edit = false) {
    const result = this.store.result(resultId);
    const task = this.store.getTask(result.taskId, edit);
    new ResultRevisions(this.store).get(resultId, revisionId);
    return task;
  }

  private get(resultId: string, revisionId: string, referenceId: string): ResultReference {
    const row = this.store.db
      .prepare(
        'SELECT body FROM result_references WHERE result_id=? AND result_revision_id=? AND id=?',
      )
      .get(resultId, revisionId, referenceId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '关联不存在或不属于此成果版本', 404);
    return JSON.parse(row.body) as ResultReference;
  }

  list(resultId: string, revisionId: string): ResultReferenceList {
    this.parent(resultId, revisionId);
    const rows = this.store.db
      .prepare(
        `SELECT body FROM result_references
         WHERE result_id=? AND result_revision_id=? AND removed_at IS NULL
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(resultId, revisionId, RESULT_REFERENCE_LIMIT) as { body: string }[];
    return {
      items: rows.map((row) => JSON.parse(row.body) as ResultReference),
      limit: RESULT_REFERENCE_LIMIT,
    };
  }

  add(resultId: string, revisionId: string, input: unknown, key: string): ResultReference {
    const data = parseAddResultReference(input);
    return this.store.mutate(
      `result.reference.add:${resultId}`,
      key,
      { resultRevisionId: revisionId, input },
      () => {
        const task = this.parent(resultId, revisionId, true);
        const { count } = this.store.db
          .prepare(
            'SELECT COUNT(*) AS count FROM result_references WHERE result_id=? AND result_revision_id=? AND removed_at IS NULL',
          )
          .get(resultId, revisionId) as { count: number };
        if (count >= RESULT_REFERENCE_LIMIT)
          throw new DomainError(
            'RESULT_REFERENCE_LIMIT',
            `每个成果版本最多保留 ${RESULT_REFERENCE_LIMIT} 个有效关联`,
            409,
          );
        const reference: ResultReference = {
          id: randomUUID(),
          resultId,
          resultRevisionId: revisionId,
          taskId: task.id,
          kind: data.kind,
          title: data.title,
          url: data.url,
          environment: data.environment || null,
          sourceNote: data.sourceNote || null,
          source: 'manual',
          externalState: 'unknown',
          availability: 'not_checked',
          recordedBy: { id: this.store.actorId, name: this.store.actorName() },
          recordedAt: new Date().toISOString(),
          removedAt: null,
          removedBy: null,
        };
        this.store.db
          .prepare(
            'INSERT INTO result_references(id,result_id,result_revision_id,removed_at,body) VALUES(?,?,?,NULL,?)',
          )
          .run(reference.id, resultId, revisionId, JSON.stringify(reference));
        this.event(reference, 'result.reference.added', reference.recordedAt, task.projectId);
        return reference;
      },
      () => {
        this.parent(resultId, revisionId, true);
      },
    );
  }

  remove(
    resultId: string,
    revisionId: string,
    referenceId: string,
    input: unknown,
    key: string,
  ): ResultReference {
    parseRemoveResultReference(input);
    return this.store.mutate(
      `result.reference.remove:${resultId}`,
      key,
      { resultRevisionId: revisionId, referenceId, input },
      () => {
        const task = this.parent(resultId, revisionId, true);
        const reference = this.get(resultId, revisionId, referenceId);
        if (reference.removedAt !== null) return reference;
        const removed: ResultReference = {
          ...reference,
          removedAt: new Date().toISOString(),
          removedBy: { id: this.store.actorId, name: this.store.actorName() },
        };
        this.store.db
          .prepare('UPDATE result_references SET removed_at=?,body=? WHERE id=?')
          .run(removed.removedAt, JSON.stringify(removed), referenceId);
        this.event(removed, 'result.reference.removed', removed.removedAt!, task.projectId);
        return removed;
      },
      () => {
        this.parent(resultId, revisionId, true);
        this.get(resultId, revisionId, referenceId);
      },
    );
  }

  private event(reference: ResultReference, kind: string, at: string, projectId: string | null) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(?,?,?,?,?)')
      .run(reference.taskId, kind, at, this.store.spaceId, projectId);
  }
}
