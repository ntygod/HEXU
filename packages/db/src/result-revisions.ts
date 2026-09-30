import { randomUUID } from 'node:crypto';
import { DomainError, type Result } from '../../contracts/src/index.js';
import type {
  ResultDetail,
  ResultRevision,
  ResultRevisionSummary,
} from '../../contracts/src/results.js';
import type { Store } from './store.js';
import { ResultCodeStore } from './result-code.js';

/** Immutable snapshots behind the existing Result container. Callers own write transactions. */
export class ResultRevisions {
  constructor(readonly store: Store) {}
  get(resultId: string, revisionId: string): ResultRevision {
    this.store.result(resultId); // Current parent permission applies to direct version reads too.
    const row = this.store.db
      .prepare('SELECT body FROM result_revisions WHERE result_id=? AND id=?')
      .get(resultId, revisionId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '成果版本不存在或不属于此成果', 404);
    return JSON.parse(row.body) as ResultRevision;
  }
  current(result: Result) {
    const row = this.store.db
      .prepare('SELECT id FROM result_revisions WHERE result_id=? AND revision=?')
      .get(result.id, result.revision) as { id: string } | undefined;
    if (!row) throw new DomainError('RESULT_VERSION_MISSING', '当前成果缺少固定版本', 409);
    return this.get(result.id, row.id);
  }
  detail(id: string, revisionId?: string): ResultDetail {
    const result = this.store.result(id),
      version = revisionId ? this.get(id, revisionId) : this.current(result);
    const messages = this.store.messages(result.taskId).filter((m) => m.resultId === id);
    return {
      result,
      task: this.store.getTask(result.taskId),
      version,
      code: new ResultCodeStore(this.store).view(version),
      revisions: this.list(id),
      messages: messages.filter((m) => m.resultRevisionId === version.id),
      unversionedMessages: messages.filter((m) => !m.resultRevisionId),
    };
  }
  list(resultId: string): ResultRevisionSummary[] {
    this.store.result(resultId);
    return (
      this.store.db
        .prepare(
          `SELECT json_object('id',id,'revision',revision,
      'title',json_extract(body,'$.title'),'createdAt',json_extract(body,'$.createdAt'),
      'createdBy',json_extract(body,'$.createdBy')) AS summary
      FROM result_revisions WHERE result_id=? ORDER BY revision DESC LIMIT 100`,
        )
        .all(resultId) as { summary: string }[]
    ).map((row) => JSON.parse(row.summary) as ResultRevisionSummary);
  }
  append(result: Result, source: ResultRevision['source'], limitations = '', legacy = false) {
    const version: ResultRevision = {
      id: randomUUID(),
      resultId: result.id,
      taskId: result.taskId,
      revision: result.revision,
      title: result.title,
      body: result.body,
      kind: result.kind,
      limitations,
      source,
      createdBy: legacy ? null : { id: this.store.actorId, name: this.store.actorName() },
      createdAt: result.updatedAt,
    };
    this.store.db
      .prepare('INSERT INTO result_revisions(id,result_id,revision,body) VALUES(?,?,?,?)')
      .run(version.id, result.id, version.revision, JSON.stringify(version));
    return version;
  }
}
