import { DomainError, type Task } from '../../contracts/src/index.js';
import {
  parseParticipantChange,
  type TaskParticipantsView,
  type ParticipantPerson,
  type ParticipantReceipt,
  type ParticipantEvent,
  type ParticipantHistory,
  type ParticipationState,
  type ProjectTaskPeople,
} from '../../contracts/src/task-participants.js';
import { assertRevision } from '../../domain/src/index.js';
import { demoMembers } from './seed.js';
import type { Store } from './store.js';

interface ParticipantRow {
  task_id: string;
  user_id: string;
  name: string;
  state: ParticipationState;
  updated_at: string;
}
/** Collaboration metadata, not an access grant or model input. */
export class TaskParticipantsStore {
  constructor(private readonly store: Store) {}
  private check(id: string, write = false) {
    const task = this.store.getTask(id, write);
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError(
        'PARTICIPANTS_UNAVAILABLE',
        '仅项目可见任务支持参与关系；私有任务不会因此共享',
        422,
      );
    this.store.project(task.projectId);
    return task;
  }
  private members(projectId: string, spaceId: string): ParticipantPerson[] {
    if (!this.store.teamMode)
      return demoMembers.map(({ id, name }) => ({ id, name, role: 'edit' }));
    return this.store.db
      .prepare(
        `SELECT p.id,p.name,pm.role FROM collab_project_members pm
      JOIN collab_memberships sm ON sm.user_id=pm.user_id AND sm.space_id=?
      JOIN collab_people p ON p.id=pm.user_id WHERE pm.project_id=? ORDER BY p.name,p.id`,
      )
      .all(spaceId, projectId) as unknown as ParticipantPerson[];
  }
  private revision(id: string) {
    return (
      (
        this.store.db
          .prepare('SELECT revision FROM task_participant_sets WHERE task_id=?')
          .get(id) as { revision: number } | undefined
      )?.revision ?? 1
    );
  }
  view(id: string): TaskParticipantsView {
    const task = this.check(id);
    const members = this.members(task.projectId!, task.spaceId);
    const rows = this.store.db
      .prepare('SELECT * FROM task_participants WHERE task_id=? ORDER BY updated_at DESC,user_id')
      .all(id) as unknown as ParticipantRow[];
    return {
      taskId: id,
      revision: this.revision(id),
      canManage: !this.store.teamMode || this.store.permissions.canTask(task, true),
      candidates: members,
      participants: rows.map((row) => {
        const member = members.find((person) => person.id === row.user_id);
        return {
          id: row.user_id,
          name: member?.name ?? row.name,
          state: row.state,
          available: !!member,
          role: member?.role ?? null,
          updatedAt: row.updated_at,
        };
      }),
    };
  }
  /** Only read DTOs consume this projection. Stored Task JSON and execution context stay unchanged. */
  decorate(task: Task): Task {
    if (task.visibility !== 'project' || !task.projectId)
      return { ...task, participantUserIds: [] };
    const members = new Set(this.members(task.projectId, task.spaceId).map((person) => person.id));
    const rows = this.store.db
      .prepare(
        "SELECT user_id FROM task_participants WHERE task_id=? AND state='active' ORDER BY user_id",
      )
      .all(task.id) as { user_id: string }[];
    return {
      ...task,
      participantUserIds: rows.map((row) => row.user_id).filter((id) => members.has(id)),
    };
  }
  change(id: string, input: unknown, key: string): ParticipantReceipt {
    const data = parseParticipantChange(input);
    const managing = data.userId !== this.store.actorId;
    this.check(id, managing); // Current parent access, including for historical receipts.
    return this.store.mutate(`task.participants:${id}`, key, data, () => {
      const task = this.check(id, managing);
      assertRevision(this.revision(id), data.expectedRevision);
      const member = this.members(task.projectId!, task.spaceId).find(
        (person) => person.id === data.userId,
      );
      const row = this.store.db
        .prepare('SELECT * FROM task_participants WHERE task_id=? AND user_id=?')
        .get(id, data.userId) as ParticipantRow | undefined;
      if (data.action === 'add') {
        if (!member)
          throw new DomainError(
            'PARTICIPANT_UNAVAILABLE',
            '该成员当前不在此项目，请刷新后选择',
            409,
          );
        if (row?.state === 'active') return { taskId: id, revision: this.revision(id) };
      } else if (!row || row.state !== 'active') return { taskId: id, revision: this.revision(id) };
      const state = data.action === 'add' ? 'active' : managing ? 'removed' : 'left';
      const action =
        data.action === 'add' ? (managing ? 'added' : 'joined') : managing ? 'removed' : 'left';
      return this.record(
        task.id,
        task.spaceId,
        data.userId,
        member?.name ?? row!.name,
        state,
        action,
      );
    });
  }
  private record(
    id: string,
    spaceId: string,
    userId: string,
    name: string,
    state: ParticipationState,
    action: ParticipantEvent['action'],
  ): ParticipantReceipt {
    const revision = this.revision(id) + 1,
      at = new Date().toISOString();
    this.store.db
      .prepare(
        'INSERT INTO task_participant_sets VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision',
      )
      .run(id, revision);
    this.store.db
      .prepare(
        `INSERT INTO task_participants(task_id,user_id,name,state,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(task_id,user_id) DO UPDATE SET name=excluded.name,state=excluded.state,updated_at=excluded.updated_at`,
      )
      .run(id, userId, name, state, at);
    this.store.db
      .prepare(
        `INSERT INTO task_participant_events(task_id,revision,user_id,name,action,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(id, revision, userId, name, action, this.store.actorId, this.store.actorName(), at);
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,?,?,?)')
      .run(id, 'task.participants_changed', at, spaceId);
    return { taskId: id, revision };
  }
  /** Called inside the existing membership transaction, before deleting project access. */
  revokeProjectMember(projectId: string, userId: string) {
    const rows = this.store.db
      .prepare(
        `SELECT p.*,t.space_id FROM task_participants p JOIN tasks t ON t.id=p.task_id
      WHERE t.project_id=? AND t.space_id=? AND p.user_id=? AND p.state='active'`,
      )
      .all(projectId, this.store.spaceId, userId) as unknown as (ParticipantRow & {
      space_id: string;
    })[];
    for (const row of rows)
      this.record(row.task_id, row.space_id, userId, row.name, 'access_revoked', 'access_revoked');
  }
  /** Same transaction as space removal; rejoining does not reactivate the old relation. */
  revokeSpaceMember(spaceId: string, userId: string) {
    const projects = this.store.db
      .prepare('SELECT id FROM projects WHERE space_id=?')
      .all(spaceId) as { id: string }[];
    for (const project of projects) this.revokeProjectMember(project.id, userId);
  }
  history(id: string, query: { limit: number; before: number | null }): ParticipantHistory {
    this.check(id);
    const rows = this.store.db
      .prepare(
        `SELECT task_id AS taskId,revision,user_id AS userId,name,action,
      actor_id AS actorId,actor_name AS actorName,created_at AS createdAt FROM task_participant_events
      WHERE task_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?`,
      )
      .all(id, query.before, query.before, query.limit + 1) as unknown as ParticipantEvent[];
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.revision : null };
  }
  people(projectId: string): ProjectTaskPeople {
    const project = this.store.project(projectId);
    const participants = this.members(projectId, project.spaceId);
    const owners = new Map<string, ProjectTaskPeople['owners'][number]>(
      participants.map((person) => [
        person.id,
        {
          id: person.id,
          name: person.name,
          availability: person.role === 'view' ? 'read_only' : 'available',
        },
      ]),
    );
    for (const task of this.store
      .tasks()
      .filter((task) => task.projectId === projectId && task.visibility === 'project')) {
      if (owners.has(task.ownerUserId)) continue;
      const owner = this.store.taskAssignment.options(task.id).owner;
      owners.set(owner.id, { ...owner, name: owner.name ?? '原负责人（姓名未记录）' });
    }
    return { owners: [...owners.values()], participants };
  }
}
