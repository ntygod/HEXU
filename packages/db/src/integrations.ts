import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import type { CommitCheckpoint } from '../../contracts/src/checkpoints.js';
import type { RetentionManifest } from '../../contracts/src/checkpoint-retention.js';
import type { TransferTicket } from '../../contracts/src/checkpoint-transfer.js';
import {
  INTEGRATION_LIMITS,
  parseIntegrationCreate,
  parseIntegrationApply,
  parseIntegrationApplicationReport,
  parseIntegrationRecoveryReport,
  parseIntegrationReport,
  type IntegrationOperation,
  type IntegrationSource,
  type IntegrationTarget,
  type IntegrationMaterial,
  type IntegrationView,
  type IntegrationOptions,
  type IntegrationRecoveryObservation,
} from '../../contracts/src/integrations.js';
import {
  INTEGRATION_TRIAL_DIFFERENCE_LIMITS,
  parseIntegrationTrialDifference,
  type IntegrationTrialDifferenceReport,
  type IntegrationTrialDifferenceReceipt,
  type IntegrationTrialDifferenceSummary,
  type IntegrationTrialDifferenceDetail,
} from '../../contracts/src/integration-trial.js';
import {
  parseIntegrationFileRestorationCreate,
  parseIntegrationFileRestorationCancel,
  parseIntegrationFileRestorationInspect,
  parseIntegrationFileRestorationReport,
  parseIntegrationFileRestorationRecoveryReport,
  type IntegrationFileRestoration,
  type IntegrationFileRestorationRequest,
  type IntegrationFileRestorationReport,
  type IntegrationFileRestorationReceipt,
  type IntegrationFileRestorationRecoveryObservation,
  type IntegrationFileRestorationRecoveryReceipt,
} from '../../contracts/src/integration-restorations.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import { CheckpointTransferStore } from './checkpoint-transfer.js';
import { ResultRevisions } from './result-revisions.js';
import { WorkBranchStore } from './work-branches.js';
import { codeHash } from './result-code.js';
import type { Store } from './store.js';

/** Frozen read-only preflight plus a separately authorized, one-shot bounded application. */
export class IntegrationStore {
  readonly transfers: CheckpointTransferStore;
  constructor(readonly store: Store) {
    this.transfers = new CheckpointTransferStore(store);
  }
  private get retained() {
    return this.transfers.retained;
  }
  private task(taskId: string, write = false) {
    const task = this.store.getTask(taskId, write);
    if (!this.store.teamMode || !task.projectId || task.visibility !== 'project')
      throw new DomainError('INTEGRATION_SCOPE', '当前只支持同项目共享任务的本人节点预检', 422);
    return task;
  }
  private source(taskId: string, resultId: string, revisionId: string): IntegrationSource {
    const task = this.task(taskId),
      v = new ResultRevisions(this.store).get(resultId, revisionId),
      s = v.source;
    if (v.taskId !== taskId || s.kind !== 'work_branch' || s.code === 'not_captured')
      throw new DomainError('INTEGRATION_SOURCE', '请选择本任务保存了代码引用的固定成果版本', 409);
    const branch = new WorkBranchStore(this.store).branch(taskId, s.branchId);
    if (branch.groupId !== s.groupId || branch.resultId !== resultId)
      throw new DomainError('INTEGRATION_SOURCE', '成果不属于原方案', 409);
    const c = this.retained.checkpoints.get(taskId, s.code.checkpoint.id);
    if (
      canonicalJson(c) !== canonicalJson(s.code.checkpoint) ||
      c.request.nodeId !== s.run.nodeId ||
      c.request.workspaceId !== s.run.workingCopyId
    )
      throw new DomainError('INTEGRATION_SOURCE', '成果引用与原节点目录不一致', 409);
    // The source owner's current grant is separate from the requesting target owner.
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(c.request.requestedBy.id) as unknown as IdentityUser | undefined;
    if (!user) throw new DomainError('INTEGRATION_SOURCE_REVOKED', '来源所有者已不可访问', 409);
    this.store.as({ user, spaceId: task.spaceId }, () => {
      this.task(taskId, true);
      this.checkpointAuthority(taskId, c);
    });
    return {
      resultId,
      revisionId,
      revision: v.revision,
      title: v.title,
      branchId: s.branchId,
      branchName: s.branchName,
      code: s.code,
    };
  }
  private checkpointAuthority(taskId: string, c: CommitCheckpoint) {
    const task = this.task(taskId, true),
      n = this.retained.checkpoints.nodes.ownedExecutionNode(c.request.nodeId);
    if (
      n.platform !== 'linux' ||
      n.project_id !== task.projectId ||
      n.space_id !== task.spaceId ||
      c.request.nodeRevision !== n.revision ||
      c.request.requestedBy.id !== n.owner_id ||
      !(JSON.parse(n.grants) as { id: string }[]).some((w) => w.id === c.request.workspaceId)
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原节点、目录或项目授权已变化', 409);
    return n;
  }
  private target(
    taskId: string,
    checkpointId: string,
    retentionId: string,
    fresh: boolean,
  ): IntegrationTarget {
    const checkpoint = this.retained.checkpoints.get(taskId, checkpointId, true);
    this.checkpointAuthority(taskId, checkpoint);
    const r = this.retained.get(taskId, checkpointId, retentionId);
    if (
      !r.manifest ||
      r.request.nodeId !== checkpoint.request.nodeId ||
      r.request.workspaceId !== checkpoint.request.workspaceId ||
      r.request.ownerId !== this.store.actorId ||
      r.manifest.commit !== checkpoint.manifest.commit ||
      r.manifest.tree !== checkpoint.manifest.tree ||
      (fresh && (r.state !== 'retained' || !r.nodeAuthorized))
    )
      throw new DomainError(
        'INTEGRATION_TARGET_UNAVAILABLE',
        '目标需要当前本人节点的有效提交恢复副本',
        409,
      );
    return { checkpoint, retentionId, manifest: r.manifest };
  }
  private material(
    taskId: string,
    source: IntegrationSource,
    target: IntegrationTarget,
    selected: Pick<IntegrationMaterial, 'kind' | 'id'>,
    fresh: boolean,
  ): IntegrationMaterial {
    const c = source.code.checkpoint;
    let manifest: RetentionManifest;
    if (selected.kind === 'retention') {
      const r = this.retained.get(taskId, c.id, selected.id);
      if (
        !r.manifest ||
        r.request.nodeId !== target.checkpoint.request.nodeId ||
        r.request.ownerId !== this.store.actorId ||
        (fresh && (r.state !== 'retained' || !r.nodeAuthorized))
      )
        throw new DomainError(
          'INTEGRATION_MATERIAL_UNAVAILABLE',
          '来源副本不在目标节点，需先完成明确传输',
          409,
        );
      manifest = r.manifest;
    } else {
      const row = this.store.db
        .prepare('SELECT body FROM checkpoint_transfers WHERE id=? AND task_id=?')
        .get(selected.id, taskId) as { body: string } | undefined;
      if (!row) throw new DomainError('NOT_FOUND', '来源传输不存在或不属于任务', 404);
      const ticket = JSON.parse(row.body) as TransferTicket;
      const t = this.transfers.get(taskId, c.id, ticket.source.id, selected.id);
      if (
        ticket.source.checkpointId !== c.id ||
        ticket.target.id !== target.checkpoint.request.nodeId ||
        ticket.target.ownerId !== this.store.actorId ||
        !t.authorized ||
        t.state !== 'received' ||
        !t.receivedAt
      )
        throw new DomainError(
          'INTEGRATION_MATERIAL_UNAVAILABLE',
          '需目标节点已确认接收的独立来源副本',
          409,
        );
      manifest = ticket.manifest;
    }
    if (
      manifest.commit !== c.manifest.commit ||
      manifest.tree !== c.manifest.tree ||
      manifest.objectFormat !== c.manifest.objectFormat ||
      manifest.repositoryIdentity !== c.manifest.repositoryIdentity ||
      (fresh && manifest.expiresAt <= new Date().toISOString())
    )
      throw new DomainError(
        'INTEGRATION_MATERIAL_UNAVAILABLE',
        '来源副本与固定提交不一致或已到期',
        409,
      );
    if (target.manifest.objectFormat !== manifest.objectFormat)
      throw new DomainError('INTEGRATION_FORMAT', '来源与目标必须使用相同Git对象格式', 409);
    return { ...selected, manifest };
  }
  private idle(target: IntegrationTarget) {
    if (
      this.store.db
        .prepare("SELECT 1 FROM node_dispatches WHERE node_id=? AND stage!='terminal'")
        .get(target.checkpoint.request.nodeId)
    )
      throw new DomainError(
        'INTEGRATION_WRITER_ACTIVE',
        '目标节点仍有活动或未知执行，请先核对终止',
        409,
      );
  }
  private inputs(taskId: string, data: ReturnType<typeof parseIntegrationCreate>, fresh: boolean) {
    const source = this.source(taskId, data.resultId, data.resultRevisionId),
      target = this.target(taskId, data.targetCheckpointId, data.targetRetentionId, fresh),
      material = this.material(taskId, source, target, data.sourceMaterial, fresh);
    if (fresh) this.idle(target);
    return { source, target, material };
  }
  private authority(o: IntegrationOperation, fresh: boolean) {
    const inputs = this.inputs(
      o.taskId,
      {
        resultId: o.source.resultId,
        resultRevisionId: o.source.revisionId,
        targetCheckpointId: o.target.checkpoint.id,
        targetRetentionId: o.target.retentionId,
        sourceMaterial: o.material,
        expectedTaskRevision: 0,
        confirmPreflight: true,
      },
      fresh,
    );
    if (
      canonicalJson(inputs) !==
      canonicalJson({ source: o.source, target: o.target, material: o.material })
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '固定来源、目标或副本发生变化', 409);
  }
  options(taskId: string, resultId: string, revisionId: string): IntegrationOptions {
    const task = this.task(taskId, true),
      source = this.source(taskId, resultId, revisionId);
    const cps = this.store.db
      .prepare(
        "SELECT id FROM commit_checkpoints WHERE task_id=? AND json_extract(body,'$.request.requestedBy.id')=? ORDER BY rowid DESC LIMIT 50",
      )
      .all(taskId, this.store.actorId) as { id: string }[];
    const sourceRetentions = this.retained.list(taskId, source.code.checkpoint.id).items;
    const transfers = this.store.db
      .prepare('SELECT id FROM checkpoint_transfers WHERE task_id=? ORDER BY rowid DESC LIMIT 100')
      .all(taskId) as { id: string }[];
    const targets: IntegrationOptions['targets'] = [];
    candidates: for (const cp of cps)
      for (const r of this.retained.list(taskId, cp.id).items) {
        if (targets.length >= 50) break candidates;
        try {
          const target = this.target(taskId, cp.id, r.request.id, true);
          this.idle(target);
          const materials = [
            ...sourceRetentions.map((r) => ({ kind: 'retention' as const, id: r.request.id })),
            ...transfers.map((t) => ({ kind: 'transfer' as const, id: t.id })),
          ].flatMap((m) => {
            try {
              return [this.material(taskId, source, target, m, true)];
            } catch (e) {
              if (e instanceof DomainError) return [];
              throw e;
            }
          });
          if (materials.length) targets.push({ target, materials });
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
        }
      }
    return { source, taskRevision: task.revision, targets };
  }
  private row(taskId: string, id: string): IntegrationOperation {
    this.task(taskId);
    const r = this.store.db
      .prepare('SELECT body FROM integration_operations WHERE id=? AND task_id=?')
      .get(id, taskId) as { body: string } | undefined;
    if (!r) throw new DomainError('NOT_FOUND', '整合预检记录不存在', 404);
    return JSON.parse(r.body) as IntegrationOperation;
  }
  private view(o: IntegrationOperation, targetOnly = false): IntegrationView {
    let available = true,
      unavailableReason: string | null = null,
      canCancel = false,
      canApply = false,
      canTrial = false,
      canRestoreFiles = false,
      canCancelFileRestoration = false;
    const taskRevision = this.task(o.taskId).revision,
      recovery = this.recovery(o.id),
      restoration = this.restoration(o.id);
    // Metadata/history remains readable after material expiry or node revocation.
    try {
      if (targetOnly)
        throw new DomainError(
          'INTEGRATION_TARGET_ONLY',
          '文件恢复只核对当前目标权限，不重新读取来源材料',
        );
      this.authority(o, true);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      available = false;
      unavailableReason = e.message;
    }
    try {
      if (targetOnly)
        throw new DomainError('INTEGRATION_TARGET_ONLY', '文件恢复不授权来源材料操作');
      this.owner(o);
      this.authority(o, false);
      canCancel =
        !recovery &&
        ['queued', 'awaiting_choice', 'conflict'].includes(o.state) &&
        !o.application?.reports.length;
      canApply =
        available &&
        !o.application &&
        ['awaiting_choice', 'conflict'].includes(o.state) &&
        !!o.report?.plan &&
        !o.report.plan.omittedFiles &&
        o.report.plan.files.some((f) => f.action === 'add' && f.source && !f.target && !f.base);
      canTrial =
        available &&
        !o.application &&
        ['awaiting_choice', 'conflict'].includes(o.state) &&
        !!o.report?.plan &&
        !o.report.plan.omittedFiles &&
        o.report.plan.files.some(
          (f) => !f.conflict && ['add', 'modify', 'delete'].includes(f.action),
        );
    } catch {
      /* read-only viewer */
    }
    let completedReportHash: string | null = null;
    try {
      completedReportHash = codeHash(this.completedApplication(o));
      this.targetAuthority(o);
      canCancelFileRestoration =
        !!restoration &&
        restoration.state === 'queued' &&
        !restoration.reports.length &&
        !restoration.recovery;
      if (!restoration) {
        this.idle(o.target);
        canRestoreFiles = true;
      }
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
    }
    return {
      operation: o,
      available,
      unavailableReason,
      canCancel,
      canApply,
      canTrial,
      taskRevision,
      reportHash: o.report ? codeHash(o.report) : null,
      recovery,
      restoration,
      completedReportHash,
      canRestoreFiles,
      canCancelFileRestoration,
    };
  }
  private trialHistoryAccess(taskId: string, id: string) {
    // A Task may have changed visibility since the original integration. Its current
    // readers can still read shared history; creation-only scope is not a read gate.
    this.store.getTask(taskId);
    if (
      !this.store.db
        .prepare('SELECT 1 FROM integration_operations WHERE id=? AND task_id=?')
        .get(id, taskId)
    )
      throw new DomainError('NOT_FOUND', '整合预检记录不存在', 404);
  }
  /** Shared candidate history uses current Task read access, never material availability. */
  listTrials(taskId: string, id: string): { items: IntegrationTrialDifferenceSummary[] } {
    this.trialHistoryAccess(taskId, id);
    const rows = this.store.db
      .prepare(
        'SELECT body,hash,received_at FROM integration_trial_differences WHERE integration_id=? ORDER BY received_at DESC,trial_id DESC',
      )
      .all(id) as { body: string; hash: string; received_at: string }[];
    return {
      items: rows.map((row) => {
        const report = JSON.parse(row.body) as IntegrationTrialDifferenceReport;
        return {
          trialId: report.trialId,
          hash: row.hash,
          materializedAt: report.materializedAt,
          comparedAt: report.comparedAt,
          receivedAt: row.received_at,
          selectedPathCount: report.selectedPaths.length,
          changedFiles: report.difference.changedFiles,
          omittedFiles: report.difference.omittedFiles,
        };
      }),
    };
  }
  getTrial(taskId: string, id: string, trialId: string): IntegrationTrialDifferenceDetail {
    this.trialHistoryAccess(taskId, id);
    const row = this.store.db
      .prepare(
        'SELECT body,hash,received_at FROM integration_trial_differences WHERE integration_id=? AND trial_id=?',
      )
      .get(id, trialId) as { body: string; hash: string; received_at: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '此整合的候选差异不存在', 404);
    return { report: JSON.parse(row.body), hash: row.hash, receivedAt: row.received_at };
  }
  publishTrialDifference(token: string, input: unknown): IntegrationTrialDifferenceReceipt {
    const report = parseIntegrationTrialDifference(input),
      hash = codeHash(report);
    return this.store.atomic(() =>
      this.forNode(token, report.integrationId, (o) => {
        // An immutable report is historical evidence, not a request to generate or apply.
        // Current source, target and Task authority precede even an exact old receipt;
        // material expiry, a newer application or cancellation does not erase evidence.
        this.owner(o);
        const preflight = o.report,
          plan = preflight?.plan;
        if (
          o.inputHash !==
            codeHash({
              id: o.id,
              taskId: o.taskId,
              source: o.source,
              target: o.target,
              material: o.material,
            }) ||
          report.integrationInputHash !== o.inputHash ||
          !preflight ||
          !plan ||
          plan.omittedFiles ||
          report.preflightReportHash !== codeHash(preflight) ||
          report.materializedAt < preflight.observedAt ||
          Date.parse(report.comparedAt) > Date.now() + 60000 ||
          report.selectedPaths.some((path) => {
            const file = plan.files.find((file) => file.path === path);
            return !file || file.conflict || !['add', 'modify', 'delete'].includes(file.action);
          })
        )
          throw new DomainError(
            'INTEGRATION_TRIAL_MISMATCH',
            '候选差异与原固定输入、完整预检、选择或时间不匹配',
            409,
          );
        for (const file of report.difference.files) {
          const original = plan.files.find((item) => item.path === file.path)!;
          if (
            canonicalJson(file.before) !== canonicalJson(original.target) ||
            canonicalJson(file.after) !== canonicalJson(original.source)
          )
            throw new DomainError(
              'INTEGRATION_TRIAL_MISMATCH',
              '候选差异必须使用原目标与所选来源的完整文件标识',
              409,
            );
          for (const [version, content] of [
            [file.before, file.beforeText],
            [file.after, file.afterText],
          ] as const) {
            if (version && version.objectId.length !== o.target.manifest.commit.length)
              throw new DomainError('INVALID_INPUT', '候选差异对象格式不匹配');
            if (
              version &&
              content !== undefined &&
              createHash(o.target.manifest.objectFormat)
                .update(`blob ${version.bytes}\0`)
                .update(content)
                .digest('hex') !== version.objectId
            )
              throw new DomainError('INVALID_INPUT', '共享候选正文与固定blob标识不一致');
          }
        }
        const old = this.store.db
          .prepare(
            'SELECT integration_id,hash,received_at,body FROM integration_trial_differences WHERE trial_id=?',
          )
          .get(report.trialId) as
          | { integration_id: string; hash: string; received_at: string; body: string }
          | undefined;
        if (old) {
          if (
            old.integration_id !== o.id ||
            old.hash !== hash ||
            canonicalJson(JSON.parse(old.body)) !== canonicalJson(report)
          )
            throw new DomainError('INTEGRATION_TRIAL_FIXED', '同一候选的共享差异不能替换', 409);
          return {
            integrationId: o.id,
            trialId: report.trialId,
            hash: old.hash,
            receivedAt: old.received_at,
          };
        }
        const count = this.store.db
          .prepare('SELECT COUNT(*) AS n FROM integration_trial_differences WHERE integration_id=?')
          .get(o.id) as { n: number };
        if (count.n >= INTEGRATION_TRIAL_DIFFERENCE_LIMITS.reports)
          throw new DomainError('INTEGRATION_TRIAL_LIMIT', '本次整合已达100份候选差异', 409);
        const receivedAt = new Date().toISOString();
        this.store.db
          .prepare(
            'INSERT INTO integration_trial_differences(integration_id,trial_id,hash,received_at,body) VALUES(?,?,?,?,?)',
          )
          .run(o.id, report.trialId, hash, receivedAt, JSON.stringify(report));
        this.store.db
          .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
          .run(o.taskId, 'integration.trial_shared', receivedAt, o.spaceId);
        return { integrationId: o.id, trialId: report.trialId, hash, receivedAt };
      }),
    );
  }
  private recovery(id: string): IntegrationRecoveryObservation | null {
    const row = this.store.db
      .prepare(
        'SELECT body,hash,received_at FROM integration_recovery_observations WHERE integration_id=?',
      )
      .get(id) as { body: string; hash: string; received_at: string } | undefined;
    return row
      ? { report: JSON.parse(row.body), hash: row.hash, receivedAt: row.received_at }
      : null;
  }
  get(taskId: string, id: string) {
    return this.view(this.row(taskId, id));
  }
  list(taskId: string) {
    this.task(taskId);
    const rows = this.store.db
      .prepare(
        'SELECT body FROM integration_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 100',
      )
      .all(taskId) as { body: string }[];
    return { items: rows.map((r) => this.view(JSON.parse(r.body) as IntegrationOperation)) };
  }
  private save(o: IntegrationOperation) {
    this.store.db
      .prepare('UPDATE integration_operations SET state=?,revision=?,body=? WHERE id=?')
      .run(o.state, o.revision, JSON.stringify(o), o.id);
    this.store.db
      .prepare('INSERT INTO integration_events VALUES(?,?,?)')
      .run(o.id, o.revision, JSON.stringify(o.history.at(-1)));
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(o.taskId, 'integration.' + o.state, new Date().toISOString(), o.spaceId);
  }
  create(taskId: string, input: unknown, key: string) {
    const data = parseIntegrationCreate(input);
    this.task(taskId, true);
    this.inputs(taskId, data, false); // Current source AND target authority before an old receipt.
    const receipt = this.store.mutate(`integration.create:${taskId}`, key, data, () => {
      const task = this.task(taskId, true);
      assertRevision(task.revision, data.expectedTaskRevision);
      const inputs = this.inputs(taskId, data, true);
      const n = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM integration_operations WHERE task_id=?')
        .get(taskId) as { n: number };
      if (n.n >= INTEGRATION_LIMITS.history)
        throw new DomainError('INTEGRATION_LIMIT', '本任务已达100条预检记录', 409);
      const createdAt = new Date().toISOString(),
        id = randomUUID();
      const o: IntegrationOperation = {
        id,
        taskId,
        projectId: task.projectId!,
        spaceId: task.spaceId,
        ...inputs,
        inputHash: codeHash({ id, taskId, ...inputs }),
        createdBy: { id: this.store.actorId, name: this.store.actorName() },
        createdAt,
        revision: 1,
        state: 'queued',
        report: null,
        application: null,
        history: [{ revision: 1, state: 'queued', at: createdAt, actorId: this.store.actorId }],
        applied: false,
      };
      this.store.db
        .prepare('INSERT INTO integration_operations VALUES(?,?,?,?,?,?)')
        .run(
          id,
          taskId,
          inputs.target.checkpoint.request.nodeId,
          o.state,
          o.revision,
          JSON.stringify(o),
        );
      this.save(o);
      return { id };
    });
    return this.get(taskId, receipt.id);
  }
  private owner(o: IntegrationOperation) {
    const task = this.task(o.taskId, true);
    if (
      o.createdBy.id !== this.store.actorId ||
      o.target.checkpoint.request.requestedBy.id !== this.store.actorId ||
      (o.application && o.application.requestedBy.id !== this.store.actorId)
    )
      throw new DomainError('NODE_OWNER_REQUIRED', '只有原目标节点本人和整合发起者可操作', 403);
    return task;
  }
  apply(taskId: string, id: string, input: unknown, key: string) {
    const data = parseIntegrationApply(input),
      original = this.row(taskId, id);
    this.owner(original);
    this.authority(original, false); // Authority before old receipts; expiry is not erasure.
    this.store.mutate(`integration.apply:${id}`, key, data, () => {
      const o = this.row(taskId, id),
        task = this.owner(o);
      assertRevision(o.revision, data.expectedRevision);
      assertRevision(task.revision, data.expectedTaskRevision);
      this.authority(o, true);
      if (o.application || !['awaiting_choice', 'conflict'].includes(o.state))
        throw new DomainError(
          'INTEGRATION_APPLICATION_FIXED',
          '本次整合已选择应用或已关闭，不能再次应用',
          409,
        );
      if (!o.report?.plan || codeHash(o.report) !== data.reportHash)
        throw new DomainError('INTEGRATION_REPORT_MISMATCH', '需选择当前固定预检报告', 409);
      const plan = o.report.plan;
      if (data.candidate) {
        const candidate = this.getTrial(taskId, id, data.candidate.trialId);
        if (
          candidate.hash !== data.candidate.reportHash ||
          candidate.hash !== codeHash(candidate.report) ||
          candidate.report.manifestHash !== data.candidate.manifestHash ||
          candidate.report.integrationInputHash !== o.inputHash ||
          candidate.report.preflightReportHash !== data.reportHash ||
          canonicalJson([...candidate.report.selectedPaths].sort()) !== canonicalJson(data.paths)
        )
          throw new DomainError(
            'INTEGRATION_CANDIDATE_MISMATCH',
            '需明确选择此整合的固定候选差异与完整路径，不使用新版本或子集替换',
            409,
          );
      }
      if (
        plan.omittedFiles ||
        data.paths.some((path) => {
          const f = plan.files.find((f) => f.path === path);
          if (!f || f.conflict) return true;
          if (data.candidate) return !['add', 'modify', 'delete'].includes(f.action);
          return f.action !== 'add' || !f.source || !!f.base || !!f.target;
        })
      )
        throw new DomainError(
          'INTEGRATION_APPLICATION_UNSUPPORTED',
          '需要完整预检中的无冲突变更；已有文件修改/移出必须另行确认固定候选，旧新增许可不适用',
          409,
        );
      const applicationId = randomUUID(),
        requestedAt = new Date().toISOString();
      o.application = {
        id: applicationId,
        reportHash: data.reportHash,
        paths: data.paths,
        ...(data.candidate ? { candidate: data.candidate } : {}),
        inputHash: codeHash({
          integrationId: o.id,
          applicationId,
          reportHash: data.reportHash,
          paths: data.paths,
          ...(data.candidate ? { candidate: data.candidate } : {}),
        }),
        requestedAt,
        requestedBy: { id: this.store.actorId, name: this.store.actorName() },
        reports: [],
      };
      o.state = 'queued';
      o.revision++;
      o.history.push({
        revision: o.revision,
        state: o.state,
        at: requestedAt,
        actorId: this.store.actorId,
      });
      this.save(o);
      return { id };
    });
    return this.get(taskId, id);
  }
  cancel(taskId: string, id: string, expectedRevision: number, key: string) {
    const original = this.row(taskId, id);
    this.owner(original);
    this.authority(original, false);
    this.store.mutate(`integration.cancel:${id}`, key, { expectedRevision }, () => {
      const o = this.row(taskId, id);
      this.owner(o);
      this.authority(o, false);
      assertRevision(o.revision, expectedRevision);
      if (this.recovery(o.id))
        throw new DomainError(
          'INTEGRATION_RECOVERY_FIXED',
          '本次应用已记录本机结算观察，不能再以未进入写入阶段取消',
          409,
        );
      if (
        !['queued', 'awaiting_choice', 'conflict'].includes(o.state) ||
        o.application?.reports.length
      )
        throw new DomainError('INTEGRATION_CLOSED', '整合已关闭或已进入写入阶段，不能取消', 409);
      o.state = 'cancelled';
      o.revision++;
      o.history.push({
        revision: o.revision,
        state: o.state,
        at: new Date().toISOString(),
        actorId: this.store.actorId,
      });
      this.save(o);
      return { id };
    });
    return this.get(taskId, id);
  }
  private forNode<T>(token: string, id: string, fn: (o: IntegrationOperation) => T) {
    const n = this.retained.checkpoints.nodes.settlementIdentity(token);
    if (n.settlementOnly) throw new DomainError('NODE_REVOKED', '节点或项目权限已撤销', 401);
    const row = this.store.db
      .prepare('SELECT task_id,node_id FROM integration_operations WHERE id=?')
      .get(id) as { task_id: string; node_id: string } | undefined;
    if (!row || row.node_id !== n.id)
      throw new DomainError('NOT_FOUND', '预检不属于此目标节点', 404);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(n.owner_id) as unknown as IdentityUser;
    return this.store.as({ user, spaceId: n.space_id }, () => {
      const o = this.row(row.task_id, id);
      this.authority(o, false);
      return fn(o);
    });
  }
  inspect(token: string, id: string) {
    return this.forNode(token, id, (o) => this.view(o));
  }
  /** Current target permission only. Never re-open source grants, objects or retention. */
  private targetAuthority(o: IntegrationOperation) {
    const task = this.owner(o),
      target = this.retained.checkpoints.get(o.taskId, o.target.checkpoint.id, true),
      node = this.checkpointAuthority(o.taskId, target),
      a = o.application;
    if (
      o.projectId !== task.projectId ||
      o.spaceId !== task.spaceId ||
      canonicalJson(target) !== canonicalJson(o.target.checkpoint) ||
      o.inputHash !==
        codeHash({
          id: o.id,
          taskId: o.taskId,
          source: o.source,
          target: o.target,
          material: o.material,
        }) ||
      !a ||
      !o.report ||
      a.reportHash !== codeHash(o.report) ||
      a.inputHash !==
        codeHash({
          integrationId: o.id,
          applicationId: a.id,
          reportHash: a.reportHash,
          paths: a.paths,
          ...(a.candidate ? { candidate: a.candidate } : {}),
        })
    )
      throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原整合、应用或目标绑定发生变化', 409);
    return { task, node };
  }
  private forTargetNode<T>(token: string, id: string, fn: (o: IntegrationOperation) => T): T {
    const n = this.retained.checkpoints.nodes.settlementIdentity(token);
    if (n.settlementOnly) throw new DomainError('NODE_REVOKED', '节点或项目权限已撤销', 401);
    const row = this.store.db
      .prepare('SELECT task_id,node_id FROM integration_operations WHERE id=?')
      .get(id) as { task_id: string; node_id: string } | undefined;
    if (!row || row.node_id !== n.id)
      throw new DomainError('NOT_FOUND', '整合不属于此原目标节点', 404);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(n.owner_id) as unknown as IdentityUser | undefined;
    if (!user) throw new DomainError('NODE_REVOKED', '原目标节点所有者已不可访问', 401);
    return this.store.as({ user, spaceId: n.space_id }, () => {
      const o = this.row(row.task_id, id),
        { node } = this.targetAuthority(o);
      if (node.id !== n.id)
        throw new DomainError('INTEGRATION_SCOPE_CHANGED', '原目标节点绑定发生变化', 409);
      return fn(o);
    });
  }
  private completedApplication(o: IntegrationOperation) {
    const a = o.application,
      start = a?.reports[0],
      done = a?.reports[1];
    if (
      !a ||
      o.state !== 'completed' ||
      !o.applied ||
      a.reports.length !== 2 ||
      !start ||
      start.sequence !== 1 ||
      start.stage !== 'applying' ||
      start.appliedPaths.length ||
      !done ||
      done.sequence !== 2 ||
      done.stage !== 'completed' ||
      [start, done].some(
        (r) => r.integrationId !== o.id || r.applicationId !== a.id || r.inputHash !== a.inputHash,
      ) ||
      done.observedAt < start.observedAt ||
      canonicalJson(done.appliedPaths) !== canonicalJson(a.paths)
    )
      throw new DomainError(
        'INTEGRATION_RESTORATION_UNAVAILABLE',
        '只有完整完成并保留原应用报告的全部已确认文件可恢复一次',
        409,
      );
    return done;
  }
  private restoration(id: string): IntegrationFileRestoration | null {
    const row = this.store.db
      .prepare(
        'SELECT body,state,revision FROM integration_file_restorations WHERE integration_id=?',
      )
      .get(id) as
      | { body: string; state: IntegrationFileRestoration['state']; revision: number }
      | undefined;
    if (!row) return null;
    const request = JSON.parse(row.body) as IntegrationFileRestorationRequest;
    const reports = this.store.db
      .prepare(
        'SELECT body FROM integration_file_restoration_reports WHERE restoration_id=? ORDER BY sequence',
      )
      .all(request.id) as { body: string }[];
    return {
      ...request,
      state: row.state,
      revision: row.revision,
      reports: reports.map((r) => JSON.parse(r.body) as IntegrationFileRestorationReport),
      recovery: this.restorationRecovery(request.id),
    };
  }
  private boundRestoration(o: IntegrationOperation, id: string) {
    const r = this.restoration(o.id),
      a = o.application!,
      done = this.completedApplication(o);
    if (!r || r.id !== id) throw new DomainError('NOT_FOUND', '原应用的文件恢复请求不存在', 404);
    const {
      inputHash,
      revision: _revision,
      state: _state,
      reports: _reports,
      recovery: _recovery,
      ...request
    } = r;
    if (
      r.integrationId !== o.id ||
      r.applicationId !== a.id ||
      r.applicationInputHash !== a.inputHash ||
      r.completedReportHash !== codeHash(done) ||
      canonicalJson(r.paths) !== canonicalJson(a.paths) ||
      r.requestedBy.id !== a.requestedBy.id ||
      r.inputHash !== codeHash(request)
    )
      throw new DomainError(
        'INTEGRATION_RESTORATION_MISMATCH',
        '恢复请求与原应用、完整范围或完成报告不匹配',
        409,
      );
    return r;
  }
  private restorationEvent(o: IntegrationOperation, state: string) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(o.taskId, 'integration.restoration_' + state, new Date().toISOString(), o.spaceId);
  }
  restoreFiles(taskId: string, id: string, input: unknown, key: string) {
    const data = parseIntegrationFileRestorationCreate(input),
      original = this.row(taskId, id);
    this.targetAuthority(original); // Authorization always precedes the stored receipt.
    this.store.mutate(`integration.restore:${id}`, key, data, () => {
      const o = this.row(taskId, id),
        { task, node } = this.targetAuthority(o),
        done = this.completedApplication(o),
        a = o.application!;
      assertRevision(o.revision, data.expectedRevision);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (this.restoration(id))
        throw new DomainError(
          'INTEGRATION_RESTORATION_FIXED',
          '原应用已有唯一的文件恢复请求，不能再次恢复',
          409,
        );
      if (
        a.id !== data.applicationId ||
        a.inputHash !== data.applicationInputHash ||
        codeHash(done) !== data.completedReportHash ||
        canonicalJson(data.paths) !== canonicalJson(a.paths)
      )
        throw new DomainError(
          'INTEGRATION_RESTORATION_MISMATCH',
          '需明确确认原应用、固定完成报告和全部已确认文件，不接受子集',
          409,
        );
      this.idle(o.target);
      const request = {
        version: 1 as const,
        kind: 'restore_confirmed_integration_files' as const,
        id: randomUUID(),
        integrationId: o.id,
        applicationId: a.id,
        applicationInputHash: a.inputHash,
        completedReportHash: data.completedReportHash,
        paths: data.paths,
        requestedAt: new Date().toISOString(),
        requestedBy: { id: this.store.actorId, name: this.store.actorName() },
      };
      const frozen: IntegrationFileRestorationRequest = {
        ...request,
        inputHash: codeHash(request),
      };
      this.store.db
        .prepare(
          'INSERT INTO integration_file_restorations(id,integration_id,application_id,node_id,state,revision,body) VALUES(?,?,?,?,?,?,?)',
        )
        .run(frozen.id, o.id, a.id, node.id, 'queued', 1, JSON.stringify(frozen));
      this.restorationEvent(o, 'queued');
      return { id };
    });
    return this.view(this.row(taskId, id), true);
  }
  cancelFileRestoration(taskId: string, id: string, input: unknown, key: string) {
    const data = parseIntegrationFileRestorationCancel(input),
      original = this.row(taskId, id);
    this.targetAuthority(original);
    this.boundRestoration(original, data.restorationId);
    this.store.mutate(`integration.restore.cancel:${id}`, key, data, () => {
      const o = this.row(taskId, id),
        { task } = this.targetAuthority(o),
        r = this.boundRestoration(o, data.restorationId);
      assertRevision(r.revision, data.expectedRevision);
      assertRevision(task.revision, data.expectedTaskRevision);
      if (r.state !== 'queued' || r.reports.length || r.recovery)
        throw new DomainError(
          'INTEGRATION_RESTORATION_CLOSED',
          '文件恢复已关闭或已进入写入阶段，不能取消',
          409,
        );
      this.store.db
        .prepare(
          "UPDATE integration_file_restorations SET state='cancelled',revision=revision+1 WHERE id=?",
        )
        .run(r.id);
      this.restorationEvent(o, 'cancelled');
      return { id };
    });
    return this.view(this.row(taskId, id), true);
  }
  inspectRestoration(token: string, input: unknown) {
    const data = parseIntegrationFileRestorationInspect(input);
    return this.store.atomic(() =>
      this.forTargetNode(token, data.integrationId, (o) => {
        this.boundRestoration(o, data.restorationId);
        return this.view(o, true);
      }),
    );
  }
  publishRestoration(token: string, input: unknown): IntegrationFileRestorationReceipt {
    const report = parseIntegrationFileRestorationReport(input),
      hash = codeHash(report);
    return this.store.atomic(() =>
      this.forTargetNode(token, report.integrationId, (o) => {
        const r = this.boundRestoration(o, report.restorationId);
        if (
          report.applicationId !== r.applicationId ||
          report.inputHash !== r.inputHash ||
          report.observedAt < r.requestedAt ||
          Date.parse(report.observedAt) > Date.now() + 60000 ||
          report.restoredPaths.some((p) => !r.paths.includes(p)) ||
          (report.stage === 'completed' &&
            canonicalJson(report.restoredPaths) !== canonicalJson(r.paths)) ||
          (r.reports.length > 0 &&
            report.originalApplicationEvidenceHash !==
              r.reports[0]!.originalApplicationEvidenceHash)
        )
          throw new DomainError(
            'INTEGRATION_RESTORATION_MISMATCH',
            '恢复报告与固定请求、原证据、范围或时间不匹配',
            409,
          );
        const old = r.reports.find((p) => p.sequence === report.sequence);
        // An accepted start receipt is permission-sensitive until preserve-only settlement.
        // Afterwards it is only historical acknowledgement, never fresh write authority.
        if (report.stage === 'restoring' && !r.recovery) this.idle(o.target);
        if (old) {
          if (codeHash(old) !== hash || canonicalJson(old) !== canonicalJson(report))
            throw new DomainError('INTEGRATION_RESTORATION_FIXED', '同阶段恢复证据不能替换', 409);
        } else {
          if (
            r.recovery &&
            (r.recovery.report.pendingReportHash !== hash ||
              r.recovery.report.originalApplicationEvidenceHash !==
                report.originalApplicationEvidenceHash ||
              report.observedAt > r.recovery.report.stoppedConfirmedAt)
          )
            throw new DomainError(
              'INTEGRATION_RESTORATION_SETTLED',
              '恢复已保留结算，只接受当时固定的原待发包，不允许新的写入声明或结果',
              409,
            );
          if (
            report.sequence !== r.reports.length + 1 ||
            (report.sequence === 1 ? r.state !== 'queued' : r.state !== 'restoring') ||
            (report.sequence === 2 &&
              (r.reports[0]!.stage !== 'restoring' || report.observedAt < r.reports[0]!.observedAt))
          )
            throw new DomainError(
              'INTEGRATION_RESTORATION_SEQUENCE',
              '恢复已关闭、缺少写入声明或时间顺序不符',
              409,
            );
          this.store.db
            .prepare(
              'INSERT INTO integration_file_restoration_reports(restoration_id,sequence,hash,received_at,body) VALUES(?,?,?,?,?)',
            )
            .run(r.id, report.sequence, hash, new Date().toISOString(), JSON.stringify(report));
          this.store.db
            .prepare(
              'UPDATE integration_file_restorations SET state=?,revision=revision+1 WHERE id=?',
            )
            .run(report.stage, r.id);
          this.restorationEvent(o, report.stage);
          r.state = report.stage;
          r.revision++;
        }
        return {
          integrationId: o.id,
          applicationId: r.applicationId,
          restorationId: r.id,
          hash,
          sequence: report.sequence,
          state: r.state,
          revision: r.revision,
        };
      }),
    );
  }
  private restorationRecovery(id: string): IntegrationFileRestorationRecoveryObservation | null {
    const row = this.store.db
      .prepare(
        'SELECT body,hash,received_at FROM integration_file_restoration_recoveries WHERE restoration_id=?',
      )
      .get(id) as { body: string; hash: string; received_at: string } | undefined;
    return row
      ? { report: JSON.parse(row.body), hash: row.hash, receivedAt: row.received_at }
      : null;
  }
  publishRestorationRecovery(
    token: string,
    input: unknown,
  ): IntegrationFileRestorationRecoveryReceipt {
    const report = parseIntegrationFileRestorationRecoveryReport(input),
      hash = codeHash(report);
    return this.store.atomic(() =>
      this.forTargetNode(token, report.integrationId, (o) => {
        const r = this.boundRestoration(o, report.restorationId);
        if (
          report.integrationInputHash !== o.inputHash ||
          report.applicationId !== r.applicationId ||
          report.applicationInputHash !== r.applicationInputHash ||
          report.restorationInputHash !== r.inputHash ||
          report.recordedRestoredCount > r.paths.length ||
          report.stoppedConfirmedAt < r.requestedAt ||
          report.releasedAt < report.stoppedConfirmedAt ||
          Date.parse(report.releasedAt) > Date.now() + 60000 ||
          r.reports.some(
            (p) =>
              p.originalApplicationEvidenceHash !== report.originalApplicationEvidenceHash ||
              p.observedAt > report.stoppedConfirmedAt,
          )
        )
          throw new DomainError(
            'INTEGRATION_RESTORATION_RECOVERY_MISMATCH',
            '结算观察与原恢复、完整范围、证据或时间不匹配',
            409,
          );
        const old = r.recovery;
        if (old) {
          if (old.hash !== hash || canonicalJson(old.report) !== canonicalJson(report))
            throw new DomainError(
              'INTEGRATION_RESTORATION_RECOVERY_FIXED',
              '本次恢复的保留结算观察不能替换',
              409,
            );
          return {
            integrationId: o.id,
            applicationId: r.applicationId,
            restorationId: r.id,
            recoveryId: report.recoveryId,
            hash: old.hash,
            receivedAt: old.receivedAt,
          };
        }
        const receivedAt = new Date().toISOString();
        this.store.db
          .prepare(
            'INSERT INTO integration_file_restoration_recoveries(restoration_id,integration_id,recovery_id,hash,received_at,body) VALUES(?,?,?,?,?,?)',
          )
          .run(r.id, o.id, report.recoveryId, hash, receivedAt, JSON.stringify(report));
        this.restorationEvent(o, 'recovery_observed');
        return {
          integrationId: o.id,
          applicationId: r.applicationId,
          restorationId: r.id,
          recoveryId: report.recoveryId,
          hash,
          receivedAt,
        };
      }),
    );
  }
  publishRecovery(token: string, input: unknown) {
    const report = parseIntegrationRecoveryReport(input),
      hash = codeHash(report);
    return this.store.atomic(() =>
      this.forTargetNode(token, report.integrationId, (o) => {
        const a = o.application!;
        if (
          o.inputHash !== report.integrationInputHash ||
          a.id !== report.applicationId ||
          a.inputHash !== report.applicationInputHash ||
          report.recordedAddedCount > a.paths.length ||
          report.stoppedConfirmedAt < a.requestedAt ||
          report.releasedAt < report.stoppedConfirmedAt ||
          Date.parse(report.releasedAt) > Date.now() + 60000
        )
          throw new DomainError(
            'INTEGRATION_RECOVERY_MISMATCH',
            '结算观察与原整合、应用范围或时间不匹配',
            409,
          );
        const old = this.recovery(o.id);
        if (old) {
          if (old.hash !== hash || canonicalJson(old.report) !== canonicalJson(report))
            throw new DomainError('INTEGRATION_RECOVERY_FIXED', '原应用的结算观察不能替换', 409);
          return {
            integrationId: o.id,
            applicationId: a.id,
            recoveryId: report.recoveryId,
            hash: old.hash,
            receivedAt: old.receivedAt,
          };
        }
        const receivedAt = new Date().toISOString();
        this.store.db
          .prepare(
            'INSERT INTO integration_recovery_observations(integration_id,application_id,recovery_id,hash,received_at,body) VALUES(?,?,?,?,?,?)',
          )
          .run(o.id, a.id, report.recoveryId, hash, receivedAt, JSON.stringify(report));
        this.store.db
          .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
          .run(o.taskId, 'integration.recovery_observed', receivedAt, o.spaceId);
        return {
          integrationId: o.id,
          applicationId: a.id,
          recoveryId: report.recoveryId,
          hash,
          receivedAt,
        };
      }),
    );
  }
  publishApplication(token: string, input: unknown) {
    const report = parseIntegrationApplicationReport(input),
      digest = codeHash(report);
    return this.store.atomic(() =>
      this.forNode(token, report.integrationId, (o) => {
        this.owner(o);
        const a = o.application;
        if (
          !a ||
          a.id !== report.applicationId ||
          a.inputHash !== report.inputHash ||
          !o.report ||
          a.reportHash !== codeHash(o.report) ||
          report.observedAt < a.requestedAt ||
          Date.parse(report.observedAt) > Date.now() + 60000 ||
          report.appliedPaths.some((path) => !a.paths.includes(path)) ||
          (report.stage === 'completed' &&
            canonicalJson(report.appliedPaths) !== canonicalJson(a.paths))
        )
          throw new DomainError(
            'INTEGRATION_APPLICATION_MISMATCH',
            '应用记录、选择范围或观察时间不匹配',
            409,
          );
        // Applying is a current-authority claim before writes, including a lost-ACK retry.
        // A no-write abort or terminal evidence may settle after expiry, never revocation.
        if (report.stage === 'applying') this.authority(o, true);
        const old = a.reports.find((r) => r.sequence === report.sequence);
        if (old) {
          if (codeHash(old) !== digest)
            throw new DomainError('INTEGRATION_APPLICATION_FIXED', '同阶段应用证据不能替换', 409);
        } else {
          if (
            report.sequence !== a.reports.length + 1 ||
            (report.sequence === 1 ? o.state !== 'queued' : o.state !== 'applying') ||
            (report.sequence === 2 &&
              (a.reports[0]!.stage !== 'applying' || report.observedAt < a.reports[0]!.observedAt))
          )
            throw new DomainError(
              'INTEGRATION_APPLICATION_SEQUENCE',
              '应用阶段已关闭、缺少写入声明或时间顺序不符',
              409,
            );
          a.reports.push(report);
          o.state = report.stage;
          o.applied = report.stage === 'completed';
          o.revision++;
          o.history.push({
            revision: o.revision,
            state: o.state,
            at: new Date().toISOString(),
            actorId: this.store.actorId,
          });
          this.save(o);
        }
        return {
          integrationId: o.id,
          applicationId: a.id,
          hash: digest,
          sequence: report.sequence,
          state: o.state,
          revision: o.revision,
        };
      }),
    );
  }
  publish(token: string, input: unknown) {
    const report = parseIntegrationReport(input),
      digest = codeHash(report);
    return this.forNode(token, report.integrationId, (o) =>
      this.store.atomic(() => {
        if (
          o.inputHash !== report.inputHash ||
          report.observedAt < o.createdAt ||
          Date.parse(report.observedAt) > Date.now() + 60000
        )
          throw new DomainError('INTEGRATION_REPORT_MISMATCH', '预检来源指纹或观察时间不匹配', 409);
        if (o.report) {
          if (codeHash(o.report) !== digest)
            throw new DomainError('INTEGRATION_REPORT_FIXED', '原预检报告不能替换', 409);
        } else {
          if (o.state !== 'queued')
            throw new DomainError('INTEGRATION_CLOSED', '预检已取消或关闭', 409);
          this.authority(o, !!report.plan);
          if (report.plan) {
            const p = report.plan,
              size = o.target.manifest.commit.length;
            if (
              p.sourceSnapshotHash !== o.material.manifest.snapshotHash ||
              p.targetSnapshotHash !== o.target.manifest.snapshotHash ||
              p.files.some((f) =>
                [f.base, f.source, f.target].some((v) => v && v.objectId.length !== size),
              )
            )
              throw new DomainError('INTEGRATION_REPORT_MISMATCH', '预检对象与固定副本不一致', 409);
          }
          o.report = report;
          o.state = !report.plan
            ? 'failed'
            : report.plan.conflicts || report.plan.omittedFiles
              ? 'conflict'
              : 'awaiting_choice';
          o.revision++;
          o.history.push({
            revision: o.revision,
            state: o.state,
            at: new Date().toISOString(),
            actorId: this.store.actorId,
          });
          this.save(o);
        }
        return { integrationId: o.id, hash: digest, state: o.state, revision: o.revision };
      }),
    );
  }
}
