import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { IdentityUser } from '../../contracts/src/identity.js';
import {
  parseBranchPreservationCreate,
  parseBranchPreservationReport,
  type BranchPreservationRequest,
  type BranchPreservationReport,
  type BranchPreservationView,
  type BranchPreservationReceipt,
} from '../../contracts/src/branch-preservation.js';
import { canonicalJson, assertRevision } from '../../domain/src/index.js';
import { BranchCleanupChecks } from './branch-cleanup-check.js';
import type { Store } from './store.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
type Row = {
  id: string;
  task_id: string;
  branch_id: string;
  node_id: string;
  state: BranchPreservationView['state'];
  revision: number;
  body: string;
};
export class BranchPreservations {
  readonly checks: BranchCleanupChecks;
  constructor(readonly store: Store) {
    this.checks = new BranchCleanupChecks(store);
  }
  private row(id: string) {
    const r = this.store.db.prepare('SELECT * FROM branch_preservations WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!r) throw new DomainError('NOT_FOUND', '移出保留请求不存在或不可访问', 404);
    return r;
  }
  private request(row: Row) {
    const r = JSON.parse(row.body) as BranchPreservationRequest;
    if (
      r.version !== 1 ||
      r.kind !== 'preserve_complete_branch_directory' ||
      r.id !== row.id ||
      r.taskId !== row.task_id ||
      r.branchId !== row.branch_id ||
      r.nodeId !== row.node_id ||
      hash({ ...r, inputHash: '' }) !== r.inputHash
    )
      throw new DomainError('BRANCH_PRESERVATION_INVALID', '固定移出保留请求不一致', 409);
    return r;
  }
  private authority(row: Row) {
    const r = this.request(row),
      c = this.checks.ownerContext(r.taskId, r.branchId);
    if (
      c.task.projectId !== r.projectId ||
      c.task.spaceId !== r.spaceId ||
      c.node.id !== r.nodeId ||
      c.node.owner_id !== r.ownerId ||
      c.node.revision !== r.scope.material.checkpoint.request.nodeRevision ||
      c.branch.workingCopyId !== r.scope.branch.workingCopyId ||
      c.op.proof!.originHash !== r.scope.originHash
    )
      throw new DomainError(
        'BRANCH_PRESERVATION_SCOPE_CHANGED',
        '原方案、节点、目录或当前权限已变化',
        409,
      );
    return r;
  }
  private beginning(row: Row) {
    const r = this.authority(row);
    if (!['requested', 'moving'].includes(row.state))
      throw new DomainError('BRANCH_PRESERVATION_CLOSED', '原移出保留请求已关闭或需核对', 409);
    const current = this.checks.inspectForOwner(r.taskId, r.selection, r.id);
    if (canonicalJson(current) !== canonicalJson(r.scope))
      throw new DomainError(
        'BRANCH_PRESERVATION_SCOPE_CHANGED',
        '原固定修订或副本观察已变化，请保留现场并重新安排',
        409,
      );
    return r;
  }
  private view(row: Row): BranchPreservationView {
    const request = this.request(row);
    let canBegin = false,
      canCancel = false,
      unavailableReason: string | null = null;
    if (['requested', 'moving'].includes(row.state))
      try {
        this.beginning(row);
        canBegin = true;
      } catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
        unavailableReason = cause.message;
      }
    if (row.state === 'requested')
      try {
        this.authority(row);
        canCancel = true;
      } catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
      }
    return {
      request,
      state: row.state,
      revision: row.revision,
      reports: (
        this.store.db
          .prepare(
            'SELECT body,hash,received_at FROM branch_preservation_reports WHERE preservation_id=? ORDER BY sequence',
          )
          .all(row.id) as { body: string; hash: string; received_at: string }[]
      ).map((r) => ({
        report: parseBranchPreservationReport(JSON.parse(r.body)),
        hash: r.hash,
        receivedAt: r.received_at,
      })),
      canBegin,
      canCancel,
      unavailableReason,
      executionRegistrationClosed: row.state === 'preserved',
    };
  }
  get(taskId: string, branchId: string, id: string) {
    this.checks.branches.branch(taskId, branchId);
    const row = this.row(id);
    if (row.task_id !== taskId || row.branch_id !== branchId)
      throw new DomainError('NOT_FOUND', '此保留请求不属于当前方案', 404);
    return this.view(row);
  }
  list(taskId: string, branchId: string) {
    this.checks.branches.branch(taskId, branchId);
    return {
      items: (
        this.store.db
          .prepare(
            'SELECT * FROM branch_preservations WHERE task_id=? AND branch_id=? ORDER BY rowid DESC LIMIT 20',
          )
          .all(taskId, branchId) as Row[]
      ).map((r) => this.view(r)),
    };
  }
  create(taskId: string, branchId: string, input: unknown, key: string) {
    const data = parseBranchPreservationCreate(input);
    this.checks.ownerContext(taskId, branchId);
    const result = this.store.mutate(`branch.preserve:${branchId}`, key, data, () => {
      const c = this.checks.ownerContext(taskId, branchId),
        selection = {
          branchId,
          expectedRevision: data.expectedRevision,
          expectedTaskRevision: data.expectedTaskRevision,
          retentionId: data.retentionId,
        },
        scope = this.checks.inspectForOwner(taskId, selection);
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM branch_preservations WHERE branch_id=? AND state IN ('requested','moving','preserved','needs_attention')",
          )
          .get(branchId)
      )
        throw new DomainError(
          'BRANCH_PRESERVATION_EXISTS',
          '原移出保留请求未处置或已完成，请核对原记录，不能再次移动',
          409,
        );
      if (
        Number(
          this.store.db
            .prepare('SELECT COUNT(*) n FROM branch_preservations WHERE branch_id=?')
            .get(branchId)!.n,
        ) >= 20
      )
        throw new DomainError('BRANCH_PRESERVATION_LIMIT', '此方案移出保留请求达到上限', 409);
      const r: BranchPreservationRequest = {
        version: 1,
        kind: 'preserve_complete_branch_directory',
        id: randomUUID(),
        taskId,
        branchId,
        nodeId: c.node.id,
        ownerId: c.node.owner_id,
        projectId: c.node.project_id,
        spaceId: c.node.space_id,
        selection,
        scope,
        inputHash: '',
        requestedAt: new Date().toISOString(),
        requestedBy: { id: this.store.actorId, name: this.store.actorName() },
      };
      r.inputHash = hash(r);
      this.store.db
        .prepare('INSERT INTO branch_preservations VALUES(?,?,?,?,?,?,?)')
        .run(r.id, taskId, branchId, r.nodeId, 'requested', 1, JSON.stringify(r));
      this.event(r, 'branch.preservation.requested');
      return { id: r.id };
    });
    return this.get(taskId, branchId, result.id);
  }
  cancel(taskId: string, branchId: string, id: string, expectedRevision: number, key: string) {
    this.get(taskId, branchId, id);
    this.authority(this.row(id));
    this.store.mutate(`branch.preserve.cancel:${id}`, key, { expectedRevision }, () => {
      const row = this.row(id),
        r = this.authority(row);
      assertRevision(row.revision, expectedRevision);
      if (
        row.state !== 'requested' ||
        this.store.db
          .prepare('SELECT 1 FROM branch_preservation_reports WHERE preservation_id=?')
          .get(id)
      )
        throw new DomainError(
          'BRANCH_PRESERVATION_STARTED',
          '原节点已开始或尚未确认，不能用取消回滚移动',
          409,
        );
      this.store.db
        .prepare("UPDATE branch_preservations SET state='cancelled',revision=revision+1 WHERE id=?")
        .run(id);
      this.event(r, 'branch.preservation.cancelled');
      return { id };
    });
    return this.get(taskId, branchId, id);
  }
  private asNode<T>(
    token: string,
    id: string,
    action: (row: Row, request: BranchPreservationRequest) => T,
  ): T {
    const n = this.checks.retained.checkpoints.nodes.settlementIdentity(token);
    if (n.settlementOnly) throw new DomainError('NODE_REVOKED', '节点授权已撤销', 401);
    const row = this.row(id),
      r = this.request(row);
    if (
      n.id !== r.nodeId ||
      n.owner_id !== r.ownerId ||
      n.project_id !== r.projectId ||
      n.space_id !== r.spaceId
    )
      throw new DomainError('NOT_FOUND', '移出保留请求不属于此原节点', 404);
    const user = this.store.db
      .prepare('SELECT id,name,email FROM collab_people WHERE id=?')
      .get(n.owner_id) as unknown as IdentityUser;
    return this.store.as({ user, spaceId: n.space_id }, () => action(row, this.authority(row)));
  }
  inspect(token: string, id: string) {
    return this.asNode(token, id, (row) => this.view(row));
  }
  publish(token: string, input: unknown): BranchPreservationReceipt {
    const report = parseBranchPreservationReport(input);
    return this.store.atomic(() =>
      this.asNode(token, report.preservationId, (row, r) => {
        if (report.inputHash !== r.inputHash)
          throw new DomainError('BRANCH_PRESERVATION_SCOPE_CHANGED', '报告不能替换固定原请求', 409);
        const digest = hash(report),
          old = this.store.db
            .prepare(
              'SELECT hash FROM branch_preservation_reports WHERE preservation_id=? AND sequence=?',
            )
            .get(row.id, report.sequence) as { hash: string } | undefined;
        const receipt = {
          preservationId: row.id,
          acceptedSequence: report.sequence,
          reportHash: digest,
        };
        if (old) {
          if (old.hash !== digest)
            throw new DomainError(
              'BRANCH_PRESERVATION_REPORT_CHANGED',
              '同序号不能改写原移出保留证据',
              409,
            );
          return receipt;
        }
        if (report.observedAt < r.requestedAt || Date.parse(report.observedAt) > Date.now() + 60000)
          throw new DomainError(
            'BRANCH_PRESERVATION_REPORT_INVALID',
            '报告时间不属于本次移出保留',
            409,
          );
        if (report.sequence === 1) {
          if (row.state !== 'requested')
            throw new DomainError('BRANCH_PRESERVATION_CLOSED', '原请求已取消或关闭', 409);
          if (report.stage === 'moving') this.beginning(row);
        } else {
          const first = this.store.db
            .prepare(
              'SELECT body FROM branch_preservation_reports WHERE preservation_id=? AND sequence=1',
            )
            .get(row.id) as { body: string } | undefined;
          const prior = first ? parseBranchPreservationReport(JSON.parse(first.body)) : null;
          if (
            row.state !== 'moving' ||
            !prior ||
            prior.stage !== 'moving' ||
            prior.destinationRef !== report.destinationRef ||
            report.observedAt < prior.observedAt
          )
            throw new DomainError(
              'BRANCH_PRESERVATION_REPORT_INVALID',
              '报告顺序或原保留位置标识不一致',
              409,
            );
        }
        const at = new Date().toISOString();
        this.store.db
          .prepare('INSERT INTO branch_preservation_reports VALUES(?,?,?,?,?)')
          .run(row.id, report.sequence, digest, at, JSON.stringify(report));
        this.store.db
          .prepare('UPDATE branch_preservations SET state=?,revision=revision+1 WHERE id=?')
          .run(report.stage, row.id);
        this.event(r, 'branch.preservation.' + report.stage);
        return receipt;
      }),
    );
  }
  private event(r: BranchPreservationRequest, kind: string) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(r.taskId, kind, new Date().toISOString(), r.spaceId);
  }
}
