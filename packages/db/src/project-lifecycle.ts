import { DomainError, type Project, type Run, type Task } from '../../contracts/src/index.js';
import {
  parseProjectLifecycle,
  type ProjectActivity,
} from '../../contracts/src/project-lifecycle.js';
import type { ContinuationOperation } from '../../contracts/src/continuation.js';
import { assertRevision, isActiveRun } from '../../domain/src/index.js';
import { NextInputs } from './next-inputs.js';
import type { Store } from './store.js';

type Row = { body: string };
export const PROJECT_ARCHIVED = {
  code: 'PROJECT_ARCHIVED',
  message: '项目已归档；请恢复项目后重新配置执行。旧派发和等待安排不会自动重启。',
};

/** Project state and all launch revocations commit together, without invoking a provider. */
export class ProjectLifecycleStore {
  constructor(private readonly store: Store) {}

  /** Internal runner check; never expose this unscoped lookup through an API. */
  isArchived(projectId: string | null): boolean {
    if (!projectId) return false;
    const row = this.store.db.prepare('SELECT body FROM projects WHERE id=?').get(projectId) as
      | Row
      | undefined;
    return !!row && !!(JSON.parse(row.body) as Project).archivedAt;
  }
  assertExecution(taskId: string) {
    const task = this.store.getTask(taskId, true);
    if (this.isArchived(task.projectId))
      throw new DomainError(PROJECT_ARCHIVED.code, PROJECT_ARCHIVED.message, 409);
    return task;
  }
  private tasks(id: string) {
    return (
      this.store.db
        .prepare('SELECT body FROM tasks WHERE project_id=? AND space_id=?')
        .all(id, this.store.spaceId) as Row[]
    ).map((row) => JSON.parse(row.body) as Task);
  }
  activity(id: string): ProjectActivity {
    const project = this.store.project(id);
    const visible = this.tasks(id).filter(
      (task) => !this.store.teamMode || this.store.permissions.canTask(task),
    );
    const activeRuns = visible.flatMap((task) =>
      this.store.runs(task.id).filter((run) => isActiveRun(run.state)),
    );
    let pendingContinuations = 0;
    for (const table of ['continuation_operations', 'node_continuation_operations'])
      for (const task of visible)
        pendingContinuations += (
          this.store.db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${table} WHERE task_id=? AND state IN ('waiting_for_stop','preparing')`,
            )
            .get(task.id) as { n: number }
        ).n;
    return { project, activeRuns, pendingContinuations };
  }
  change(id: string, input: unknown, key: string): { project: Project; stopRunIds: string[] } {
    const check = () => {
      const project = this.store.project(id);
      if (this.store.teamMode) this.store.permissions.project(id, 'manage');
      return project;
    };
    check(); // Also required before replaying a saved receipt.
    const data = parseProjectLifecycle(input);
    return this.store.mutate(`project.lifecycle:${id}`, key, data, () => {
      const current = check();
      assertRevision(current.revision, data.expectedRevision);
      const { access: _access, memberIds: _members, ...base } = current;
      const archiving = data.action === 'archive';
      if (!!base.archivedAt === archiving) return { project: base, stopRunIds: [] };
      const at = new Date().toISOString();
      const project: Project = {
        ...base,
        revision: base.revision + 1,
        archivedAt: archiving ? at : null,
        archivedBy: archiving ? this.store.actorId : null,
      };
      this.store.db
        .prepare('UPDATE projects SET body=? WHERE id=? AND space_id=?')
        .run(JSON.stringify(project), id, this.store.spaceId);
      this.store.projectSettings.record(project, this.store.actorId, this.store.actorName(), at);
      const stopRunIds: string[] = [];
      if (archiving) {
        for (const task of this.tasks(id)) {
          const writable = !this.store.teamMode || this.store.permissions.canTask(task, true);
          const notify = (kind: string) =>
            this.store.db
              .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
              .run(task.id, kind, at, task.spaceId);
          // Suspend even if restored before the next coordinator tick. Never thaw a frozen plan.
          for (const table of ['continuation_operations', 'node_continuation_operations']) {
            const rows = this.store.db
              .prepare(
                `SELECT body FROM ${table} WHERE task_id=? AND state IN ('waiting_for_stop','preparing')`,
              )
              .all(task.id) as Row[];
            for (const row of rows) {
              const op = JSON.parse(row.body) as ContinuationOperation;
              const next = {
                ...op,
                state: 'needs_attention',
                blockers: [PROJECT_ARCHIVED],
                revision: op.revision + 1,
                updatedAt: at,
              };
              this.store.db
                .prepare(`UPDATE ${table} SET state=?,body=? WHERE id=?`)
                .run(next.state, JSON.stringify(next), op.id);
              notify('continuation.updated');
            }
          }
          const rows = this.store.db
            .prepare('SELECT body FROM runs WHERE task_id=?')
            .all(task.id) as Row[];
          for (const row of rows) {
            const run = JSON.parse(row.body) as Run;
            if (!isActiveRun(run.state)) continue;
            const dispatch = run.node
              ? (this.store.db
                  .prepare('SELECT stage FROM node_dispatches WHERE id=?')
                  .get(run.node.dispatchId) as { stage: string })
              : undefined;
            const neverPermitted = !!dispatch && ['queued', 'accepted'].includes(dispatch.stage);
            // Preview preparing may still be before an asynchronous spawn. Invalidate it durably.
            const previewPending =
              run.provider !== 'node' && ['queued', 'preparing'].includes(run.state);
            const requestStop = data.activeRunAction === 'stop' && writable;
            if (!neverPermitted && !previewPending && !requestStop) continue;
            const cancelled = neverPermitted || (previewPending && run.provider === 'mock');
            const next: Run = {
              ...run,
              state: cancelled ? 'cancelled' : 'stopping',
              revision: run.revision + 1,
              updatedAt: at,
              ...(neverPermitted
                ? {
                    observation: 'fresh',
                    node: { ...run.node!, phase: 'terminal', terminationConfirmed: true },
                  }
                : {}),
            };
            this.store.db
              .prepare('UPDATE runs SET body=? WHERE id=?')
              .run(JSON.stringify(next), run.id);
            if (neverPermitted) {
              this.store.db
                .prepare("UPDATE node_dispatches SET stage='terminal',updated_at=? WHERE id=?")
                .run(at, run.node!.dispatchId);
              new NextInputs(this.store).notStarted(run.id);
            }
            // No lock deletion and no invented terminal evidence for a permitted/unknown writer.
            if (writable) stopRunIds.push(run.id);
            notify('run.updated');
          }
        }
      }
      this.store.db
        .prepare(
          'INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(NULL,?,?,?,?)',
        )
        .run(archiving ? 'project.archived' : 'project.restored', at, this.store.spaceId, id);
      return { project, stopRunIds };
    });
  }
}
