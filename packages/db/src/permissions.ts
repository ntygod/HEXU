import type { DatabaseSync } from 'node:sqlite';
import { DomainError, type Task } from '../../contracts/src/index.js';
import type { Principal, ProjectRole, Space } from '../../contracts/src/identity.js';

/** One server-side policy for reads, writes, search, direct IDs and streams. */
export class PermissionService {
  constructor(
    readonly db: DatabaseSync,
    private current: () => Principal,
  ) {}
  space(id = this.current().spaceId): Space {
    const { user } = this.current();
    const row = this.db
      .prepare(
        `SELECT s.id,s.name,s.kind,m.role FROM collab_spaces s
      JOIN collab_memberships m ON m.space_id=s.id WHERE s.id=? AND m.user_id=?`,
      )
      .get(id, user.id) as unknown as Space | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '空间不存在或访问已撤销', 404);
    return row;
  }
  manageSpace(id = this.current().spaceId) {
    const space = this.space(id);
    if (space.kind === 'personal' || !['owner', 'admin'].includes(space.role))
      throw new DomainError('FORBIDDEN', '需要团队管理权限', 403);
    return space;
  }
  projectRole(id: string): ProjectRole | null {
    const { user, spaceId } = this.current();
    this.space();
    const row = this.db
      .prepare(
        `SELECT pm.role FROM projects p JOIN collab_project_members pm ON pm.project_id=p.id
      WHERE p.id=? AND p.space_id=? AND pm.user_id=?`,
      )
      .get(id, spaceId, user.id) as { role: ProjectRole } | undefined;
    return row?.role ?? null;
  }
  project(id: string, required: ProjectRole = 'view') {
    const role = this.projectRole(id);
    if (!role) throw new DomainError('NOT_FOUND', '项目不存在或不可访问', 404);
    if ((required === 'edit' && role === 'view') || (required === 'manage' && role !== 'manage'))
      throw new DomainError('FORBIDDEN', '当前项目权限不允许此操作', 403);
    return role;
  }
  canTask(task: Task, write = false): boolean {
    const { user, spaceId } = this.current();
    try {
      this.space();
      if (task.spaceId !== spaceId) return false;
      if (task.visibility === 'private') return task.ownerUserId === user.id;
      const role = task.projectId ? this.projectRole(task.projectId) : null;
      return role !== null && (!write || role !== 'view');
    } catch {
      return false;
    }
  }
  task(task: Task, write = false) {
    if (!this.canTask(task)) throw new DomainError('NOT_FOUND', '任务不存在或不可访问', 404);
    if (write && !this.canTask(task, true))
      throw new DomainError('FORBIDDEN', '只读项目不能修改任务或发起执行', 403);
  }
}
