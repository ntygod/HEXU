import { DomainError, type Result } from '../../contracts/src/index.js';
import {
  parseMemberResultVersion,
  type MemberResultVersionPreview,
  type MemberResultVersionReceipt,
} from '../../contracts/src/member-result-versions.js';
import { assertRevision } from '../../domain/src/index.js';
import { ResultRevisions } from './result-revisions.js';
import type { Store } from './store.js';

/** Explicit human-authored text versions; branch provenance stays in its own save flow. */
export class MemberResultVersions {
  readonly revisions: ResultRevisions;
  constructor(readonly store: Store) {
    this.revisions = new ResultRevisions(store);
  }

  private source(resultId: string) {
    const result = this.store.result(resultId);
    const task = this.store.getTask(result.taskId, true);
    const version = this.revisions.current(result);
    // Legacy snapshots may lack a source even though the persisted branch still owns
    // the Result. Neither that association nor a historic branch source may be erased.
    const branch = this.store.db
      .prepare(
        `SELECT 1 FROM work_branches WHERE json_extract(body,'$.resultId')=?
        OR json_extract(body,'$.resultRevisionId') IN
          (SELECT id FROM result_revisions WHERE result_id=?) LIMIT 1`,
      )
      .get(resultId, resultId);
    const branchHistory = this.store.db
      .prepare(
        `SELECT 1 FROM result_revisions WHERE result_id=?
        AND json_extract(body,'$.source.kind')='work_branch' LIMIT 1`,
      )
      .get(resultId);
    const available =
      result.kind === 'text' &&
      version.kind === 'text' &&
      version.resultId === result.id &&
      version.taskId === task.id &&
      version.revision === result.revision &&
      ['member', 'legacy'].includes(version.source.kind) &&
      !branch &&
      !branchHistory;
    return { result, task, version, available };
  }

  preview(resultId: string): MemberResultVersionPreview {
    const source = this.source(resultId);
    if (!source.available)
      return {
        available: false,
        reason: '此入口只为普通文字成果保存新版本，方案成果请从原方案保存',
      };
    if (source.result.revision >= 100)
      return { available: false, reason: '此成果已达100个固定版本' };
    return { available: true, version: source.version };
  }

  save(resultId: string, value: unknown, key: string): MemberResultVersionReceipt {
    const resolve = () => {
      const source = this.source(resultId);
      if (!source.available)
        throw new DomainError(
          'CAPABILITY_UNAVAILABLE',
          '此入口只为普通文字成果保存新版本，方案成果请从原方案保存',
          422,
        );
      return source;
    };
    let source = resolve(); // Current Task edit permission also applies to old receipts.
    const input = parseMemberResultVersion(value);
    return this.store.mutate(
      `result.member-version:${resultId}`,
      key,
      input,
      () => {
        const { result: previous, task, version: baseline } = source;
        assertRevision(previous.revision, input.expectedRevision);
        if (baseline.id !== input.expectedRevisionId)
          throw new DomainError('REVISION_CONFLICT', '成果版本已变化，请核对最新版本后再保存', 409);
        if (previous.revision >= 100)
          throw new DomainError('RESULT_VERSION_LIMIT', '此成果已达100个固定版本', 409);
        const at = new Date().toISOString();
        const result: Result = {
          ...previous,
          title: input.title,
          body: input.body,
          revision: previous.revision + 1,
          updatedAt: at,
        };
        this.store.db
          .prepare('UPDATE results SET body=? WHERE id=?')
          .run(JSON.stringify(result), result.id);
        const version = this.revisions.append(result, { kind: 'member' });
        this.store.db
          .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
          .run(task.id, 'result.version_created', at, task.spaceId);
        return { resultId, revisionId: version.id, revision: version.revision };
      },
      () => {
        // Revalidate under the same transaction as permission-sensitive replay/write.
        // The old baseline is intentionally checked only for a new write.
        source = resolve();
      },
    );
  }
}
