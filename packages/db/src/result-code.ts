import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type { BranchResultSource, ResultRevision } from '../../contracts/src/results.js';
import {
  parseCodeDifference,
  type ResultCodeReference,
  type ResultCodeOption,
  type ResultCodeEvidence,
  type ResultCodeDifference,
} from '../../contracts/src/result-code.js';
import { canonicalJson, isActiveRun } from '../../domain/src/index.js';
import { CheckpointStore } from './checkpoints.js';
import { CheckpointRetentionStore } from './checkpoint-retention.js';
import type { Store } from './store.js';

export const codeHash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export class ResultCodeStore {
  readonly checkpoints: CheckpointStore;
  readonly retained: CheckpointRetentionStore;
  constructor(readonly store: Store) {
    this.checkpoints = new CheckpointStore(store);
    this.retained = new CheckpointRetentionStore(store);
  }
  private owner(taskId: string, source: BranchResultSource) {
    const task = this.store.getTask(taskId, true);
    const node = this.checkpoints.nodes.ownedExecutionNode(source.run.nodeId);
    const run = this.store.run(source.run.id);
    if (
      task.projectId !== node.project_id ||
      task.spaceId !== node.space_id ||
      run.taskId !== taskId ||
      !run.node?.terminationConfirmed ||
      run.observation !== 'fresh' ||
      isActiveRun(run.state) ||
      run.node.workingCopyId !== source.run.workingCopyId ||
      run.node.nodeId !== source.run.nodeId ||
      run.node.workBranch?.branchId !== source.branchId
    )
      throw new DomainError('RESULT_CODE_SOURCE_CHANGED', '来源执行或方案现场不再匹配', 409);
    if (
      this.store.db
        .prepare("SELECT 1 FROM node_dispatches WHERE node_id=? AND stage!='terminal'")
        .get(node.id)
    )
      throw new DomainError(
        'RESULT_CODE_WRITER_ACTIVE',
        '方案节点仍有活动或未知执行，请先核对终止',
        409,
      );
    return node;
  }
  reference(
    taskId: string,
    source: BranchResultSource,
    checkpointId: string,
    retentionId?: string,
  ): ResultCodeReference {
    const node = this.owner(taskId, source),
      checkpoint = this.checkpoints.get(taskId, checkpointId, true);
    const c = checkpoint,
      base = source.start.checkpoint.manifest;
    if (
      c.request.nodeId !== node.id ||
      c.request.nodeRevision !== node.revision ||
      c.request.requestedBy.id !== this.store.actorId ||
      c.request.workspaceId !== source.run.workingCopyId ||
      c.request.projectId !== node.project_id ||
      c.manifest.verifiedAt < source.run.finishedAt ||
      c.request.createdAt < source.run.finishedAt ||
      c.manifest.objectFormat !== base.objectFormat
    )
      throw new DomainError(
        'RESULT_CODE_SCOPE_MISMATCH',
        '请选择此方案节点在来源Run结束后明确记录的提交引用',
        409,
      );
    const retained = retentionId ? this.retained.get(taskId, checkpointId, retentionId) : null;
    if (
      retained &&
      (retained.state !== 'retained' ||
        !retained.nodeAuthorized ||
        !retained.manifest ||
        retained.request.nodeId !== node.id ||
        retained.request.workspaceId !== c.request.workspaceId ||
        retained.manifest.commit !== c.manifest.commit ||
        retained.manifest.tree !== c.manifest.tree)
    )
      throw new DomainError(
        'RESULT_CODE_RETENTION_UNAVAILABLE',
        '所选对象副本不可用、已过期或不属于此引用',
        409,
      );
    const value = {
      kind: 'commit_reference' as const,
      checkpoint,
      base: { objectFormat: base.objectFormat, commit: base.commit, tree: base.tree },
      retention: retained?.manifest
        ? { id: retained.request.id, manifest: retained.manifest }
        : null,
    };
    return { ...value, hash: codeHash(value) };
  }
  options(taskId: string, source: BranchResultSource): ResultCodeOption[] {
    try {
      this.owner(taskId, source);
    } catch (cause) {
      if (cause instanceof DomainError && [403, 404, 409].includes(cause.status)) return [];
      throw cause;
    }
    const rows = this.store.db
      .prepare(
        "SELECT id FROM commit_checkpoints WHERE task_id=? AND json_extract(body,'$.request.nodeId')=? AND json_extract(body,'$.request.workspaceId')=? ORDER BY rowid DESC LIMIT 50",
      )
      .all(taskId, source.run.nodeId, source.run.workingCopyId) as { id: string }[];
    return rows.flatMap((row) => {
      try {
        const ref = this.reference(taskId, source, row.id);
        return [
          {
            checkpoint: ref.checkpoint,
            retentions: this.retained
              .list(taskId, row.id)
              .items.filter((v) => v.state === 'retained' && v.nodeAuthorized && v.manifest),
          },
        ];
      } catch (cause) {
        if (cause instanceof DomainError && cause.code === 'RESULT_CODE_SCOPE_MISMATCH') return [];
        throw cause;
      }
    });
  }
  view(version: ResultRevision): ResultCodeEvidence | undefined {
    const source = version.source;
    if (source.kind !== 'work_branch' || source.code === 'not_captured') return undefined;
    this.store.getTask(version.taskId);
    const row = this.store.db
      .prepare('SELECT body FROM result_code_differences WHERE revision_id=?')
      .get(version.id) as { body: string } | undefined;
    const code = source.code;
    let retention: ResultCodeEvidence['retention'] = {
      state: 'not_requested',
      observedAt: null,
      nodeAuthorized: false,
    };
    if (code.retention) {
      try {
        const current = this.retained.get(version.taskId, code.checkpoint.id, code.retention.id);
        retention = {
          state: current.state,
          observedAt: current.observedAt,
          nodeAuthorized: current.nodeAuthorized,
        };
      } catch {
        retention = { state: 'unavailable', observedAt: null, nodeAuthorized: false };
      }
    }
    let canPublish = false;
    try {
      this.reference(version.taskId, source, code.checkpoint.id);
      canPublish = true;
    } catch {
      /* Historical shared evidence remains readable. */
    }
    return {
      difference: row ? (JSON.parse(row.body) as ResultCodeDifference) : null,
      retention,
      canPublish,
    };
  }
  private forNode<T>(
    token: string,
    revisionId: string,
    fn: (version: ResultRevision, source: BranchResultSource, code: ResultCodeReference) => T,
  ) {
    const node = this.checkpoints.nodes.settlementIdentity(token);
    if (node.settlementOnly) throw new DomainError('NODE_REVOKED', '节点或项目授权已撤销', 401);
    const row = this.store.db
      .prepare('SELECT body FROM result_revisions WHERE id=?')
      .get(revisionId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '成果版本不存在', 404);
    const version = JSON.parse(row.body) as ResultRevision,
      source = version.source;
    if (
      source.kind !== 'work_branch' ||
      source.code === 'not_captured' ||
      source.run.nodeId !== node.id
    )
      throw new DomainError('NOT_FOUND', '成果代码不属于此节点', 404);
    const code = source.code;
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(node.owner_id) as unknown as IdentityUser;
    return this.store.as({ user, spaceId: node.space_id }, () => {
      this.owner(version.taskId, source);
      const checkpoint = this.checkpoints.inspectRecord(token, code.checkpoint.id);
      if (canonicalJson(checkpoint) !== canonicalJson(code.checkpoint))
        throw new DomainError('RESULT_CODE_SOURCE_CHANGED', '固定代码引用不一致', 409);
      return fn(version, source, code);
    });
  }
  inspect(token: string, revisionId: string) {
    return this.forNode(token, revisionId, (version) => ({
      version,
      evidence: this.view(version),
    }));
  }
  publish(token: string, input: unknown) {
    const data = parseCodeDifference(input);
    return this.forNode(token, data.revisionId, (version, source, code) => {
      if (
        data.referenceHash !== code.hash ||
        data.comparedAt < version.createdAt ||
        Date.parse(data.comparedAt) > Date.now() + 60000
      )
        throw new DomainError(
          'RESULT_CODE_SOURCE_CHANGED',
          '差异来源或核验时间不属于此成果版本',
          409,
        );
      for (const file of data.files)
        for (const [v, content] of [
          [file.before, file.beforeText],
          [file.after, file.afterText],
        ] as const) {
          if (v && v.objectId.length !== code.base.commit.length)
            throw new DomainError('INVALID_INPUT', '差异对象格式不匹配');
          if (
            v &&
            content !== undefined &&
            createHash(code.base.objectFormat)
              .update(`blob ${v.bytes}\0`)
              .update(content)
              .digest('hex') !== v.objectId
          )
            throw new DomainError('INVALID_INPUT', '共享正文与固定blob标识不一致');
        }
      const hash = codeHash(data);
      return this.store.atomic(() => {
        const row = this.store.db
          .prepare('SELECT digest FROM result_code_differences WHERE revision_id=?')
          .get(version.id) as { digest: string } | undefined;
        if (row && row.digest !== hash)
          throw new DomainError('RESULT_CODE_ALREADY_SHARED', '此版本已有固定差异，不能覆盖', 409);
        if (!row) {
          this.store.db
            .prepare('INSERT INTO result_code_differences VALUES(?,?,?,?,?)')
            .run(version.id, version.taskId, source.run.nodeId, hash, JSON.stringify(data));
          this.store.db
            .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
            .run(
              version.taskId,
              'result.code_shared',
              new Date().toISOString(),
              this.store.spaceId,
            );
        }
        return { revisionId: version.id, hash };
      });
    });
  }
}
