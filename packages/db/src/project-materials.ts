import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  PROJECT_MATERIAL_LIMIT,
  parseProjectMaterialRefs,
  renderProjectMaterials,
  type ProjectMaterialRef,
  type ProjectMaterialSelection,
  type ProjectMaterialSnapshot,
  type ProjectMaterialItem,
  type ProjectMaterialBundle,
  type ProjectMaterialCatalog,
  type ProjectMaterialCandidate,
  type RunMaterialView,
  type parseProjectMaterialQuery,
} from '../../contracts/src/project-materials.js';
import type { ProjectSource } from '../../contracts/src/project-sources.js';
import type { ProjectAgreement } from '../../contracts/src/project-agreements.js';
import { canonicalJson } from '../../domain/src/index.js';
import { redact } from '../../adapters/claude-code/src/index.js';
import type { Store } from './store.js';

type BundleRow = {
  id: string;
  task_id: string;
  created_at: string;
  created_by: string;
  run_id: string | null;
  operation_id: string | null;
  body: string;
  context_text: string | null;
  started_at: string | null;
};
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Supplemental project material only; original task/history preparation stays provider-specific. */
export class ProjectMaterialsStore {
  constructor(private readonly store: Store) {}
  private resource(task: Task, ref: ProjectMaterialRef, current: boolean) {
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError('MATERIAL_SCOPE_MISMATCH', '私有任务不能直接带入项目资料或约定', 409);
    const value =
      ref.kind === 'source'
        ? this.store.projectSources.get(task.projectId, ref.id)
        : this.store.projectAgreements.get(task.projectId, ref.id);
    if (
      current &&
      (value.revision !== ref.revision ||
        value.contentHash !== ref.contentHash ||
        ('deletedAt' in value ? !!value.deletedAt : value.state !== 'active'))
    )
      throw new DomainError(
        'PROJECT_MATERIAL_CHANGED',
        '所选资料或约定的版本、可用状态已变化，请重新查看选材',
        409,
      );
    return value;
  }
  assertAccess(taskId: string, selection: ProjectMaterialSelection | undefined) {
    if (!selection) return;
    const task = this.store.getTask(taskId, true);
    for (const ref of selection.items) this.resource(task, ref, false);
  }
  catalog(
    taskId: string,
    query: ReturnType<typeof parseProjectMaterialQuery>,
  ): ProjectMaterialCatalog {
    const task = this.store.getTask(taskId);
    if (task.visibility !== 'project' || !task.projectId)
      return { items: [], nextCursor: null, sourceCount: 0, agreementCount: 0 };
    this.store.project(task.projectId);
    const sources = (
      this.store.db
        .prepare(
          'SELECT body FROM project_sources WHERE project_id=? AND space_id=? ORDER BY rowid DESC',
        )
        .all(task.projectId, task.spaceId) as { body: string }[]
    )
      .map((row) => JSON.parse(row.body) as ProjectSource)
      .filter((item) => !item.deletedAt);
    const agreements = (
      this.store.db
        .prepare(
          'SELECT body FROM project_agreements WHERE project_id=? AND space_id=? ORDER BY rowid DESC',
        )
        .all(task.projectId, task.spaceId) as { body: string }[]
    )
      .map((row) => JSON.parse(row.body) as ProjectAgreement)
      .filter((item) => item.state === 'active');
    let items: ProjectMaterialCandidate[] = [
      ...agreements.map((item) => ({
        kind: 'agreement' as const,
        id: item.id,
        title: item.title,
        revision: item.revision,
        contentHash: item.contentHash,
        contentChars: item.content.length,
        excerpt: item.content.slice(0, 160),
        url: null,
      })),
      ...sources.map((item) => ({
        kind: 'source' as const,
        id: item.id,
        title: item.title,
        revision: item.revision,
        contentHash: item.contentHash,
        contentChars: item.content.length,
        excerpt: item.content.slice(0, 160),
        url: item.url,
      })),
    ];
    const q = query.q.toLocaleLowerCase();
    items = items.filter(
      (item) =>
        (query.kind === 'all' || item.kind === query.kind) &&
        (!q || `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(q)),
    );
    if (query.cursor) {
      const index = items.findIndex((item) => item.kind + ':' + item.id === query.cursor);
      if (index < 0) throw new DomainError('INVALID_CURSOR', '材料目录已变化，请重新加载', 409);
      items = items.slice(index + 1);
    }
    const selected = items.slice(0, query.limit);
    return {
      items: selected,
      nextCursor:
        items.length > query.limit ? `${selected.at(-1)!.kind}:${selected.at(-1)!.id}` : null,
      sourceCount: sources.length,
      agreementCount: agreements.length,
    };
  }
  preview(
    taskId: string,
    refs: ProjectMaterialRef[],
    clean: (value: string) => string = redact,
  ): ProjectMaterialSnapshot {
    const task = this.store.getTask(taskId, true);
    const items: ProjectMaterialItem[] = parseProjectMaterialRefs(refs).map((reference) => {
      const value = this.resource(task, reference, true);
      let prefix = value.content.slice(0, reference.maxChars);
      if (
        /[\uD800-\uDBFF]$/.test(prefix) &&
        /^[\uDC00-\uDFFF]/.test(value.content.slice(prefix.length))
      )
        prefix = prefix.slice(0, -1);
      const rawUrl = 'url' in value ? value.url : null;
      const content = clean(prefix),
        url = rawUrl ? clean(rawUrl) : null,
        title = clean(value.title);
      return {
        reference: { ...reference },
        title,
        url,
        content,
        originalChars: value.content.length,
        omittedChars: Math.max(0, value.content.length - prefix.length),
        redacted: content !== prefix || url !== rawUrl || title !== value.title,
      };
    });
    const text = renderProjectMaterials(items);
    if (text.length > PROJECT_MATERIAL_LIMIT)
      throw new DomainError(
        'MATERIAL_LIMIT',
        `项目补充材料超过 ${PROJECT_MATERIAL_LIMIT} 字符，请减少选择或使用更短摘录`,
        422,
      );
    const data = {
      taskId,
      projectId: task.projectId,
      provider: this.store.teamMode ? ('node' as const) : ('native' as const),
      items,
      text,
    };
    return {
      ...data,
      hash: digest(data),
      totalChars: text.length,
      limitChars: PROJECT_MATERIAL_LIMIT,
    };
  }
  prepare(
    taskId: string,
    selection: ProjectMaterialSelection | undefined,
    clean?: (value: string) => string,
  ) {
    if (!selection) return undefined;
    const snapshot = this.preview(taskId, selection.items, clean);
    if (snapshot.hash !== selection.expectedHash)
      throw new DomainError(
        'PROJECT_MATERIAL_CHANGED',
        '选材预览与当前资料不一致，请重新核对',
        409,
      );
    return snapshot;
  }
  assertCurrent(taskId: string, snapshot: ProjectMaterialSnapshot) {
    const task = this.store.getTask(taskId, true);
    if (
      snapshot.taskId !== taskId ||
      snapshot.projectId !== task.projectId ||
      snapshot.provider !== (this.store.teamMode ? 'node' : 'native')
    )
      throw new DomainError('MATERIAL_SCOPE_MISMATCH', '项目材料不属于当前任务或执行模式', 409);
    for (const item of snapshot.items) this.resource(task, item.reference, true);
    const { taskId: scope, projectId, provider, items, text } = snapshot;
    if (
      snapshot.totalChars !== text.length ||
      snapshot.limitChars !== PROJECT_MATERIAL_LIMIT ||
      text.length > PROJECT_MATERIAL_LIMIT ||
      text !== renderProjectMaterials(items) ||
      digest({ taskId: scope, projectId, provider, items, text }) !== snapshot.hash
    )
      throw new DomainError('MATERIAL_SNAPSHOT_INVALID', '材料快照内容不一致', 409);
  }
  verify(
    taskId: string,
    selection: ProjectMaterialSelection | undefined,
    snapshot: ProjectMaterialSnapshot | undefined,
  ) {
    if (!selection) {
      if (snapshot) throw new DomainError('MATERIAL_SNAPSHOT_INVALID', '未授权项目材料', 409);
      return;
    }
    if (
      !snapshot ||
      selection.expectedHash !== snapshot.hash ||
      canonicalJson(selection.items) !== canonicalJson(snapshot.items.map((item) => item.reference))
    )
      throw new DomainError('MATERIAL_SNAPSHOT_INVALID', '缺少本次确认的选材快照', 409);
    this.assertCurrent(taskId, snapshot);
  }
  private view(row: BundleRow): ProjectMaterialBundle {
    return {
      id: row.id,
      taskId: row.task_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by,
      runId: row.run_id,
      operationId: row.operation_id,
      snapshot: JSON.parse(row.body) as ProjectMaterialSnapshot,
      contextText: row.context_text,
      startedAt: row.started_at,
    };
  }
  private row(id: string) {
    const row = this.store.db.prepare('SELECT * FROM context_bundles WHERE id=?').get(id) as
      | BundleRow
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '材料快照不存在', 404);
    return row;
  }
  get(taskId: string, id: string) {
    this.store.getTask(taskId);
    const row = this.row(id);
    if (row.task_id !== taskId) throw new DomainError('NOT_FOUND', '材料快照不属于当前任务', 404);
    const bundle = this.view(row);
    if (bundle.snapshot.projectId) this.store.project(bundle.snapshot.projectId);
    return bundle;
  }
  forOperation(taskId: string, operationId: string) {
    this.store.getTask(taskId);
    const row = this.store.db
      .prepare('SELECT * FROM context_bundles WHERE task_id=? AND operation_id=?')
      .get(taskId, operationId) as BundleRow | undefined;
    return row ? this.view(row) : undefined;
  }
  /** Caller owns the surrounding Run/Operation + receipt transaction. */
  bindOperation(
    taskId: string,
    operationId: string,
    snapshot: ProjectMaterialSnapshot,
    contextText: string | null = null,
  ) {
    this.assertCurrent(taskId, snapshot);
    const id = randomUUID();
    this.store.db
      .prepare(
        'INSERT INTO context_bundles(id,task_id,created_at,created_by,operation_id,body,context_text) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        taskId,
        new Date().toISOString(),
        this.store.actorId,
        operationId,
        JSON.stringify(snapshot),
        contextText,
      );
    return id;
  }
  bindRun(
    taskId: string,
    runId: string,
    snapshot: ProjectMaterialSnapshot,
    contextText: string,
    operationId?: string,
  ) {
    this.assertCurrent(taskId, snapshot);
    const run = this.store.run(runId);
    if (
      run.taskId !== taskId ||
      run.provider !== snapshot.provider ||
      run.createdByUserId !== this.store.actorId
    )
      throw new DomainError('MATERIAL_SCOPE_MISMATCH', '执行和材料的任务、模式或发起者不一致', 409);
    const old = operationId ? this.forOperation(taskId, operationId) : undefined;
    if (old) {
      if (
        old.runId ||
        old.createdByUserId !== this.store.actorId ||
        old.snapshot.hash !== snapshot.hash ||
        (old.contextText !== null && old.contextText !== contextText)
      )
        throw new DomainError('MATERIAL_SNAPSHOT_INVALID', '接续材料快照或绑定已变化', 409);
      this.store.db
        .prepare('UPDATE context_bundles SET run_id=?,context_text=? WHERE id=? AND run_id IS NULL')
        .run(runId, contextText, old.id);
      return old.id;
    }
    if (operationId)
      throw new DomainError('MATERIAL_SNAPSHOT_INVALID', '接续缺少已保存的项目材料', 409);
    const id = randomUUID();
    this.store.db
      .prepare(
        'INSERT INTO context_bundles(id,task_id,created_at,created_by,run_id,body,context_text) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        taskId,
        new Date().toISOString(),
        this.store.actorId,
        runId,
        JSON.stringify(snapshot),
        contextText,
      );
    return id;
  }
  validateRun(runId: string) {
    const run = this.store.run(runId);
    const row = this.store.db.prepare('SELECT * FROM context_bundles WHERE run_id=?').get(runId) as
      | BundleRow
      | undefined;
    if (row) this.assertCurrent(run.taskId, this.view(row).snapshot);
  }
  /** Actual process/running-event evidence only, never from queueing, ACK or permit. */
  started(runId: string) {
    this.store.db
      .prepare('UPDATE context_bundles SET started_at=COALESCE(started_at,?) WHERE run_id=?')
      .run(new Date().toISOString(), runId);
  }
  runView(runId: string): RunMaterialView {
    const run = this.store.run(runId),
      row = this.store.db.prepare('SELECT * FROM context_bundles WHERE run_id=?').get(runId) as
        | BundleRow
        | undefined;
    const bundle = row ? this.get(run.taskId, row.id) : null;
    return {
      runId,
      bundle,
      state: !bundle
        ? 'unrecorded'
        : bundle.startedAt
          ? 'started'
          : run.observation === 'unknown' || run.node?.permittedAt
            ? 'uncertain'
            : 'fixed',
    };
  }
}
