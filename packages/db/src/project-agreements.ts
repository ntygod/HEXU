import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type Message } from '../../contracts/src/index.js';
import type { AgreementSearchHit } from '../../contracts/src/agreement-search.js';
import type { TaskSearchScope } from '../../contracts/src/task-search.js';
import {
  parseAgreementCreate,
  parseAgreementEdit,
  parseAgreementLifecycle,
  type ProjectAgreement,
  type AgreementPreview,
  type AgreementRevision,
  type AgreementHistory,
  type AgreementPage,
  type AgreementNotice,
  type parseAgreementQuery,
} from '../../contracts/src/project-agreements.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const decode = (row: { body: string }) => JSON.parse(row.body) as ProjectAgreement;
/** Explicit human publication of a project discussion; no change to already-authorized model work. */
export class ProjectAgreementsStore {
  constructor(private readonly store: Store) {}
  private check(projectId: string, write = false) {
    this.store.project(projectId);
    if (write && this.store.teamMode) this.store.permissions.project(projectId, 'edit');
  }
  private source(taskId: string, messageId: string, projectId?: string): AgreementPreview {
    const task = this.store.getTask(taskId);
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError('AGREEMENT_SOURCE_PRIVATE', '私有讨论不能直接公开为项目约定', 422);
    if (projectId && task.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '讨论来源不属于当前项目', 404);
    this.check(task.projectId);
    const row = this.store.db
      .prepare('SELECT body FROM messages WHERE id=? AND task_id=?')
      .get(messageId, taskId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '讨论来源不存在或不可访问', 404);
    const message = JSON.parse(row.body) as Message;
    if (message.actorType === 'system' || !message.body.trim())
      throw new DomainError(
        'AGREEMENT_SOURCE_UNSUPPORTED',
        '请选择真人讨论或可共享的 AI 回复',
        422,
      );
    return {
      origin: {
        projectId: task.projectId,
        taskId,
        taskShortId: task.shortId,
        taskTitle: task.title,
        messageId,
        actorType: message.actorType,
        actorName: message.actorName,
        createdAt: message.createdAt,
        hash: hash(message),
        excerpt: message.body.slice(0, 1000),
        truncated: message.body.length > 1000,
      },
      initialContent: message.body.slice(0, 8000),
      contentTruncated: message.body.length > 8000,
    };
  }
  preview(taskId: string, messageId: string) {
    return this.source(taskId, messageId);
  }
  get(projectId: string, id: string, write = false): ProjectAgreement {
    this.check(projectId, write);
    const row = this.store.db
      .prepare('SELECT body FROM project_agreements WHERE id=? AND project_id=? AND space_id=?')
      .get(id, projectId, this.store.spaceId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '约定不存在或不可访问', 404);
    return decode(row);
  }
  currentSearchItems(selection: TaskSearchScope): AgreementSearchHit[] {
    if (selection.scope === 'personal')
      throw new DomainError('INVALID_INPUT', '项目约定不支持无项目个人范围');
    const projects = this.store
      .projects()
      .filter((project) => selection.scope !== 'project' || project.id === selection.projectId);
    if (!projects.length) return [];
    for (const project of projects) this.check(project.id);
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const rows = this.store.db
      .prepare(
        `SELECT body FROM project_agreements WHERE space_id=? AND project_id IN (${projects.map(() => '?').join(',')}) ORDER BY rowid DESC`,
      )
      .all(this.store.spaceId, ...projectsById.keys()) as { body: string }[];
    return rows.map((row) => {
      const agreement = decode(row);
      const project = projectsById.get(agreement.projectId)!;
      return {
        id: agreement.id,
        projectId: agreement.projectId,
        title: agreement.title,
        content: agreement.content,
        revision: agreement.revision,
        state: agreement.state,
        updatedAt: agreement.updatedAt,
        project: {
          id: project.id,
          name: project.name,
          ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
        },
      };
    });
  }
  version(projectId: string): number {
    this.check(projectId);
    return (
      (
        this.store.db
          .prepare('SELECT version FROM project_agreement_versions WHERE project_id=?')
          .get(projectId) as { version: number } | undefined
      )?.version ?? 0
    );
  }
  list(projectId: string, query: ReturnType<typeof parseAgreementQuery>): AgreementPage {
    this.check(projectId);
    const rows = this.store.db
      .prepare(
        'SELECT body FROM project_agreements WHERE project_id=? AND space_id=? ORDER BY rowid DESC',
      )
      .all(projectId, this.store.spaceId) as { body: string }[];
    const q = query.q.toLocaleLowerCase();
    let items = rows
      .map(decode)
      .filter(
        (item) =>
          (query.state === 'all' || item.state === query.state) &&
          (!q || `${item.title} ${item.content}`.toLocaleLowerCase().includes(q)),
      );
    if (query.cursor) {
      const index = items.findIndex((item) => item.id === query.cursor);
      if (index < 0) throw new DomainError('INVALID_CURSOR', '约定列表已变化，请重新加载', 409);
      items = items.slice(index + 1);
    }
    return {
      items: items.slice(0, query.limit).map(({ content, origin: _origin, ...item }) => ({
        ...item,
        excerpt: content.slice(0, 160),
      })),
      nextCursor: items.length > query.limit ? items[query.limit - 1]!.id : null,
    };
  }
  private record(agreement: ProjectAgreement, action: AgreementRevision['action']) {
    this.store.db
      .prepare(
        'INSERT INTO project_agreement_revisions(agreement_id,revision,action,body) VALUES(?,?,?,?)',
      )
      .run(agreement.id, agreement.revision, action, JSON.stringify(agreement));
    this.store.db
      .prepare(
        'INSERT INTO project_agreement_versions VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET version=version+1',
      )
      .run(agreement.projectId);
    this.store.db
      .prepare(
        'INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(NULL,?,?,?,?)',
      )
      .run(
        'project.agreement_changed',
        agreement.updatedAt,
        agreement.spaceId,
        agreement.projectId,
      );
  }
  create(projectId: string, input: unknown, key: string): ProjectAgreement {
    this.check(projectId, true);
    const data = parseAgreementCreate(input);
    this.source(data.sourceTaskId, data.sourceMessageId, projectId); // Origin permissions also precede replay.
    if (data.replaces) this.get(projectId, data.replaces.id, true);
    return this.store.mutate(`project.agreement.create:${projectId}`, key, data, () => {
      this.check(projectId, true);
      const preview = this.source(data.sourceTaskId, data.sourceMessageId, projectId);
      if (preview.origin.hash !== data.expectedSourceHash)
        throw new DomainError('AGREEMENT_SOURCE_CHANGED', '讨论来源已变化，请重新核对原消息', 409);
      const previous = data.replaces ? this.get(projectId, data.replaces.id, true) : null;
      if (previous) {
        assertRevision(previous.revision, data.replaces!.expectedRevision);
        if (previous.state !== 'active')
          throw new DomainError('AGREEMENT_NOT_ACTIVE', '仅可替代当前有效的约定', 409);
      }
      const at = new Date().toISOString();
      const agreement: ProjectAgreement = {
        id: randomUUID(),
        spaceId: this.store.spaceId,
        projectId,
        title: data.title,
        content: data.content,
        contentHash: hash({ title: data.title, content: data.content }),
        origin: preview.origin,
        revision: 1,
        state: 'active',
        replacesId: previous?.id ?? null,
        supersededById: null,
        statusReason: null,
        createdAt: at,
        createdByUserId: this.store.actorId,
        createdByName: this.store.actorName(),
        updatedAt: at,
        updatedByUserId: this.store.actorId,
        updatedByName: this.store.actorName(),
      };
      this.store.db
        .prepare('INSERT INTO project_agreements(id,space_id,project_id,body) VALUES(?,?,?,?)')
        .run(agreement.id, agreement.spaceId, projectId, JSON.stringify(agreement));
      this.record(agreement, 'created');
      if (previous)
        this.save(
          {
            ...previous,
            state: 'superseded',
            supersededById: agreement.id,
            statusReason: '已由新的项目约定替代',
          },
          'superseded',
        );
      return agreement;
    });
  }
  edit(projectId: string, id: string, input: unknown, key: string): ProjectAgreement {
    this.get(projectId, id, true);
    const data = parseAgreementEdit(input);
    return this.store.mutate(`project.agreement.edit:${id}`, key, { projectId, ...data }, () => {
      const current = this.get(projectId, id, true);
      assertRevision(current.revision, data.expectedRevision);
      if (current.state !== 'active')
        throw new DomainError(
          'AGREEMENT_NOT_ACTIVE',
          '只有当前有效约定可以修改；已替代的历史不能重新生效',
          409,
        );
      const contentHash = hash({ title: data.title, content: data.content });
      if (contentHash === current.contentHash) return current;
      return this.save(
        { ...current, title: data.title, content: data.content, contentHash },
        'updated',
      );
    });
  }
  lifecycle(projectId: string, id: string, input: unknown, key: string): ProjectAgreement {
    this.get(projectId, id, true);
    const data = parseAgreementLifecycle(input);
    return this.store.mutate(
      `project.agreement.lifecycle:${id}`,
      key,
      { projectId, ...data },
      () => {
        const current = this.get(projectId, id, true);
        assertRevision(current.revision, data.expectedRevision);
        if (current.state === 'superseded')
          throw new DomainError('AGREEMENT_SUPERSEDED', '此约定已被替代，请查看后续约定', 409);
        const state = data.action === 'deactivate' ? 'inactive' : 'active';
        if (state === current.state) return current;
        return this.save(
          {
            ...current,
            state,
            statusReason: state === 'inactive' ? data.reason || '人工停用' : null,
          },
          state === 'inactive' ? 'deactivated' : 'reactivated',
        );
      },
    );
  }
  private save(previous: ProjectAgreement, action: AgreementRevision['action']): ProjectAgreement {
    const current = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId: this.store.actorId,
      updatedByName: this.store.actorName(),
    };
    this.store.db
      .prepare('UPDATE project_agreements SET body=? WHERE id=? AND project_id=? AND space_id=?')
      .run(JSON.stringify(current), current.id, current.projectId, current.spaceId);
    this.record(current, action);
    return current;
  }
  history(
    projectId: string,
    id: string,
    query: { before: number | null; limit: number },
  ): AgreementHistory {
    this.get(projectId, id);
    const rows = this.store.db
      .prepare(
        'SELECT action,body FROM project_agreement_revisions WHERE agreement_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?',
      )
      .all(id, query.before, query.before, query.limit + 1) as {
      action: AgreementRevision['action'];
      body: string;
    }[];
    const items = rows
      .slice(0, query.limit)
      .map((row) => ({ action: row.action, agreement: decode(row) }));
    return {
      items,
      nextCursor: rows.length > query.limit ? items.at(-1)!.agreement.revision : null,
    };
  }
  notice(taskId: string): AgreementNotice {
    const task = this.store.getTask(taskId);
    if (task.visibility !== 'project' || !task.projectId)
      throw new DomainError('AGREEMENT_SOURCE_PRIVATE', '私有任务不读取项目约定', 422);
    this.check(task.projectId);
    const version =
      (
        this.store.db
          .prepare('SELECT version FROM project_agreement_versions WHERE project_id=?')
          .get(task.projectId) as { version: number } | undefined
      )?.version ?? 0;
    const activeCount = Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) n FROM project_agreements WHERE project_id=? AND space_id=? AND json_extract(body,'$.state')='active'",
        )
        .get(task.projectId, task.spaceId)!.n,
    );
    return { projectId: task.projectId, version, activeCount };
  }
}
