import { randomUUID } from 'node:crypto';
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
  parseIntegrationReport,
  type IntegrationOperation,
  type IntegrationSource,
  type IntegrationTarget,
  type IntegrationMaterial,
  type IntegrationView,
  type IntegrationOptions,
} from '../../contracts/src/integrations.js';
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
  private view(o: IntegrationOperation): IntegrationView {
    let available = true,
      unavailableReason: string | null = null,
      canCancel = false,
      canApply = false;
    const taskRevision = this.task(o.taskId).revision;
    // Metadata/history remains readable after material expiry or node revocation.
    try {
      this.authority(o, true);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      available = false;
      unavailableReason = e.message;
    }
    try {
      this.owner(o);
      this.authority(o, false);
      canCancel =
        ['queued', 'awaiting_choice', 'conflict'].includes(o.state) &&
        !o.application?.reports.length;
      canApply =
        available &&
        !o.application &&
        ['awaiting_choice', 'conflict'].includes(o.state) &&
        !!o.report?.plan &&
        !o.report.plan.omittedFiles &&
        o.report.plan.files.some((f) => f.action === 'add' && f.source && !f.target && !f.base);
    } catch {
      /* read-only viewer */
    }
    return {
      operation: o,
      available,
      unavailableReason,
      canCancel,
      canApply,
      taskRevision,
      reportHash: o.report ? codeHash(o.report) : null,
    };
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
      if (
        plan.omittedFiles ||
        data.paths.some((path) => {
          const f = plan.files.find((f) => f.path === path);
          return !f || f.action !== 'add' || !f.source || !!f.base || !!f.target || !!f.conflict;
        })
      )
        throw new DomainError(
          'INTEGRATION_APPLICATION_UNSUPPORTED',
          '当前仅支持完整预检中无冲突的新增普通文件，不支持修改、删除、已存在文件或省略清单',
          409,
        );
      const applicationId = randomUUID(),
        requestedAt = new Date().toISOString();
      o.application = {
        id: applicationId,
        reportHash: data.reportHash,
        paths: data.paths,
        inputHash: codeHash({
          integrationId: o.id,
          applicationId,
          reportHash: data.reportHash,
          paths: data.paths,
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
