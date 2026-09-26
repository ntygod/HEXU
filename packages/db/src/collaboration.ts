import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type {
  IdentityUser,
  ProjectRole,
  Space,
  SpaceMember,
} from '../../contracts/src/identity.js';
import type { Store } from './store.js';
const now = () => new Date().toISOString();
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
interface Invitation {
  id: string;
  space_id: string;
  email: string;
  token_hash: string;
  created_by: string;
  expires_at: string;
  accepted_by: string | null;
  revoked: number;
}
export class CollaborationStore {
  constructor(readonly store: Store) {}
  ensurePerson(user: IdentityUser): Space[] {
    const db = this.store.db;
    // Synchronous transaction, never held while calling the authentication library.
    this.store.atomic(() => {
      db.prepare(
        `INSERT INTO collab_people(id,name,email) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email`,
      ).run(user.id, user.name, user.email);
      const id = `personal-${user.id}`;
      db.prepare(`INSERT OR IGNORE INTO collab_spaces VALUES(?,?,?,?)`).run(
        id,
        '我的个人空间',
        'personal',
        now(),
      );
      db.prepare(`INSERT OR IGNORE INTO collab_memberships VALUES(?,?,?)`).run(
        id,
        user.id,
        'owner',
      );
    });
    return this.spaces(user.id);
  }
  spaces(userId: string): Space[] {
    return this.store.db
      .prepare(
        `SELECT s.id,s.name,s.kind,m.role FROM collab_spaces s
      JOIN collab_memberships m ON m.space_id=s.id WHERE m.user_id=? ORDER BY s.kind,s.rowid`,
      )
      .all(userId) as unknown as Space[];
  }
  createSpace(name: string, key: string) {
    return this.store.mutate('space.create', key, { name }, () => {
      const id = randomUUID();
      this.store.db
        .prepare('INSERT INTO collab_spaces VALUES(?,?,?,?)')
        .run(id, name, 'team', now());
      this.store.db
        .prepare('INSERT INTO collab_memberships VALUES(?,?,?)')
        .run(id, this.store.actorId, 'owner');
      return { id, name, kind: 'team', role: 'owner' } satisfies Space;
    });
  }
  members(): SpaceMember[] {
    this.store.permissions.space();
    return this.store.db
      .prepare(
        `SELECT p.id,p.name,p.email,m.role FROM collab_memberships m
      JOIN collab_people p ON p.id=m.user_id WHERE m.space_id=? ORDER BY m.rowid`,
      )
      .all(this.store.spaceId) as unknown as SpaceMember[];
  }
  createInvitation(email: string, key: string) {
    this.store.permissions.manageSpace();
    const token = randomBytes(32).toString('base64url');
    let fresh = false;
    const item = this.store.mutate('invitation.create', key, { email }, () => {
      this.store.permissions.manageSpace();
      fresh = true;
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + 48 * 3600_000).toISOString();
      this.store.db
        .prepare('INSERT INTO collab_invitations VALUES(?,?,?,?,?,?,NULL,0)')
        .run(id, this.store.spaceId, email, digest(token), this.store.actorId, expiresAt);
      this.changed();
      return { id, email, expiresAt };
    });
    // The raw token is returned once, never stored in replay records or logs.
    return { ...item, token: fresh ? token : null };
  }
  invitation(token: string): Invitation {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new DomainError('INVITATION_INVALID', '邀请不存在、已撤销或已过期', 404);
    const row = this.store.db
      .prepare('SELECT * FROM collab_invitations WHERE token_hash=?')
      .get(digest(token)) as unknown as Invitation | undefined;
    if (!row || row.revoked || row.expires_at <= now())
      throw new DomainError('INVITATION_INVALID', '邀请不存在、已撤销或已过期', 404);
    const inviter = this.store.db
      .prepare('SELECT role FROM collab_memberships WHERE space_id=? AND user_id=?')
      .get(row.space_id, row.created_by) as { role: string } | undefined;
    if (!inviter || !['owner', 'admin'].includes(inviter.role))
      throw new DomainError('INVITATION_INVALID', '邀请者的权限已失效', 404);
    return row;
  }
  previewInvitation(token: string) {
    const invitation = this.invitation(token);
    if (invitation.accepted_by)
      throw new DomainError('INVITATION_USED', '邀请已经使用，请登录原账号', 409);
    const space = this.store.db
      .prepare('SELECT name FROM collab_spaces WHERE id=?')
      .get(invitation.space_id) as { name: string };
    return { email: invitation.email, spaceName: space.name, expiresAt: invitation.expires_at };
  }
  accept(token: string, user: IdentityUser) {
    return this.store.atomic(() => {
      const invitation = this.invitation(token);
      if (invitation.email !== user.email.toLowerCase())
        throw new DomainError('INVITATION_IDENTITY_MISMATCH', '请使用受邀邮箱对应的账号', 403);
      if (invitation.accepted_by) {
        if (
          invitation.accepted_by !== user.id ||
          !this.store.db
            .prepare('SELECT 1 FROM collab_memberships WHERE space_id=? AND user_id=?')
            .get(invitation.space_id, user.id)
        )
          throw new DomainError('INVITATION_USED', '邀请已使用，不能恢复已撤销的成员资格', 409);
        return { spaceId: invitation.space_id, alreadyJoined: true };
      }
      this.store.db
        .prepare('INSERT OR IGNORE INTO collab_memberships VALUES(?,?,?)')
        .run(invitation.space_id, user.id, 'member');
      this.store.db
        .prepare('UPDATE collab_invitations SET accepted_by=? WHERE id=? AND accepted_by IS NULL')
        .run(user.id, invitation.id);
      this.changed(invitation.space_id);
      return { spaceId: invitation.space_id, alreadyJoined: false };
    });
  }
  invitations() {
    this.store.permissions.manageSpace();
    return this.store.db
      .prepare(
        `SELECT id,email,expires_at AS expiresAt,accepted_by AS acceptedBy,revoked
      FROM collab_invitations WHERE space_id=? ORDER BY rowid DESC LIMIT 100`,
      )
      .all(this.store.spaceId);
  }
  revokeInvitation(id: string, key: string) {
    this.store.permissions.manageSpace();
    return this.store.mutate(`invitation.revoke:${id}`, key, {}, () => {
      const row = this.store.db
        .prepare('SELECT id FROM collab_invitations WHERE id=? AND space_id=?')
        .get(id, this.store.spaceId);
      if (!row) throw new DomainError('NOT_FOUND', '邀请不可访问', 404);
      this.store.db.prepare('UPDATE collab_invitations SET revoked=1 WHERE id=?').run(id);
      this.changed();
      return { revoked: true };
    });
  }
  removeMember(userId: string, key: string) {
    const space = this.store.permissions.space();
    if (userId !== this.store.actorId) this.store.permissions.manageSpace();
    if (space.kind === 'personal')
      throw new DomainError('FORBIDDEN', '个人空间不能移除所有者', 403);
    return this.store.mutate(`member.remove:${userId}`, key, {}, () => {
      const member = this.store.db
        .prepare('SELECT role FROM collab_memberships WHERE space_id=? AND user_id=?')
        .get(space.id, userId) as { role: string } | undefined;
      if (!member) return { removed: true };
      if (member.role === 'owner')
        throw new DomainError('OWNER_REQUIRED', '请保留空间所有者；管理权转移尚未接入', 409);
      // Do not strand projects. A manager must transfer project management first.
      const stranded = this.store.db
        .prepare(
          `SELECT 1 FROM collab_project_members pm JOIN projects p ON p.id=pm.project_id
        WHERE p.space_id=? AND pm.user_id=? AND pm.role='manage'
        AND NOT EXISTS(SELECT 1 FROM collab_project_members other WHERE other.project_id=pm.project_id AND other.user_id!=? AND other.role='manage')`,
        )
        .get(space.id, userId, userId);
      if (stranded)
        throw new DomainError(
          'PROJECT_MANAGER_REQUIRED',
          '此成员仍独自管理项目，请先交接项目管理权限',
          409,
        );
      this.store.taskParticipants.revokeSpaceMember(space.id, userId);
      this.store.db
        .prepare(
          'DELETE FROM collab_project_members WHERE user_id=? AND project_id IN (SELECT id FROM projects WHERE space_id=?)',
        )
        .run(userId, space.id);
      this.store.db
        .prepare('DELETE FROM collab_memberships WHERE space_id=? AND user_id=?')
        .run(space.id, userId);
      this.changed();
      return { removed: true };
    });
  }
  projectMembers(projectId: string) {
    this.store.permissions.project(projectId);
    return this.store.db
      .prepare(
        `SELECT p.id,p.name,p.email,m.role FROM collab_project_members m
      JOIN collab_people p ON p.id=m.user_id WHERE m.project_id=? ORDER BY m.rowid`,
      )
      .all(projectId);
  }
  setProjectMember(projectId: string, userId: string, role: ProjectRole | null, key: string) {
    this.store.permissions.project(projectId, 'manage');
    return this.store.mutate(`project.member:${projectId}:${userId}`, key, { role }, () => {
      this.store.permissions.project(projectId, 'manage');
      if (
        !this.store.db
          .prepare('SELECT 1 FROM collab_memberships WHERE space_id=? AND user_id=?')
          .get(this.store.spaceId, userId)
      )
        throw new DomainError('NOT_FOUND', '目标成员不在当前空间', 404);
      const old = this.store.db
        .prepare('SELECT role FROM collab_project_members WHERE project_id=? AND user_id=?')
        .get(projectId, userId) as { role: string } | undefined;
      if (
        old?.role === 'manage' &&
        role !== 'manage' &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM collab_project_members WHERE project_id=? AND user_id!=? AND role='manage'",
          )
          .get(projectId, userId)
      )
        throw new DomainError('PROJECT_MANAGER_REQUIRED', '项目必须保留一名管理者', 409);
      if (role === null) {
        this.store.taskParticipants.revokeProjectMember(projectId, userId);
        this.store.db
          .prepare('DELETE FROM collab_project_members WHERE project_id=? AND user_id=?')
          .run(projectId, userId);
      } else
        this.store.db
          .prepare(
            'INSERT INTO collab_project_members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',
          )
          .run(projectId, userId, role);
      this.changed();
      return { userId, role };
    });
  }
  changed(spaceId = this.store.spaceId) {
    this.store.db
      .prepare('INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(NULL,?,?,?)')
      .run('workspace.updated', now(), spaceId);
  }
}
