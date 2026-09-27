import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import {
  parseSourceCreate,
  parseSourceEdit,
  parseSourceLifecycle,
  type ProjectSource,
  type SourceContent,
  type SourceKind,
  type SourceListQuery,
  type SourcePage,
  type SourceRevision,
  type SourceRevisionPage,
} from '../../contracts/src/project-sources.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import type { Store } from './store.js';

const decode = (row: { body: string }) => JSON.parse(row.body) as ProjectSource;
function contentHash(kind: SourceKind, content: SourceContent) {
  return createHash('sha256')
    .update(
      canonicalJson({ kind, title: content.title, content: content.content, url: content.url }),
    )
    .digest('hex');
}
/** Project-scoped human materials. Saving them is not sending model context. */
export class ProjectSourcesStore {
  constructor(private readonly store: Store) {}
  private check(projectId: string, write = false) {
    this.store.project(projectId);
    if (write && this.store.teamMode) this.store.permissions.project(projectId, 'edit');
  }
  get(projectId: string, id: string, write = false): ProjectSource {
    this.check(projectId, write);
    const row = this.store.db
      .prepare('SELECT body FROM project_sources WHERE id=? AND project_id=? AND space_id=?')
      .get(id, projectId, this.store.spaceId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '资料不存在或不可访问', 404);
    return decode(row);
  }
  list(projectId: string, query: SourceListQuery): SourcePage {
    this.check(projectId);
    const rows = this.store.db
      .prepare(
        'SELECT body FROM project_sources WHERE project_id=? AND space_id=? ORDER BY rowid DESC',
      )
      .all(projectId, this.store.spaceId) as { body: string }[];
    const q = query.q.toLocaleLowerCase();
    let items = rows
      .map(decode)
      .filter(
        (source) =>
          !!source.deletedAt === (query.state === 'deleted') &&
          (!q ||
            `${source.title} ${source.content} ${source.url ?? ''}`
              .toLocaleLowerCase()
              .includes(q)),
      );
    if (query.cursor) {
      const at = items.findIndex((source) => source.id === query.cursor);
      if (at < 0) throw new DomainError('INVALID_CURSOR', '资料列表已变化，请重新加载', 409);
      items = items.slice(at + 1);
    }
    return {
      items: items
        .slice(0, query.limit)
        .map(({ content, ...source }) => ({ ...source, excerpt: content.slice(0, 160) })),
      nextCursor: items.length > query.limit ? items[query.limit - 1]!.id : null,
    };
  }
  private record(source: ProjectSource, action: SourceRevision['action']) {
    this.store.db
      .prepare(
        'INSERT INTO project_source_revisions(source_id,revision,action,body) VALUES(?,?,?,?)',
      )
      .run(source.id, source.revision, action, JSON.stringify(source));
    this.store.db
      .prepare(
        'INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(NULL,?,?,?,?)',
      )
      .run('project.source_changed', source.updatedAt, source.spaceId, source.projectId);
  }
  create(projectId: string, input: unknown, key: string): ProjectSource {
    this.check(projectId, true);
    const data = parseSourceCreate(input);
    return this.store.mutate(`project.source.create:${projectId}`, key, data, () => {
      this.check(projectId, true);
      const at = new Date().toISOString();
      const source: ProjectSource = {
        ...data,
        id: randomUUID(),
        projectId,
        spaceId: this.store.spaceId,
        revision: 1,
        contentHash: contentHash(data.kind, data),
        createdAt: at,
        createdByUserId: this.store.actorId,
        createdByName: this.store.actorName(),
        updatedAt: at,
        updatedByUserId: this.store.actorId,
        updatedByName: this.store.actorName(),
        deletedAt: null,
        deletedByUserId: null,
      };
      this.store.db
        .prepare('INSERT INTO project_sources(id,space_id,project_id,body) VALUES(?,?,?,?)')
        .run(source.id, source.spaceId, projectId, JSON.stringify(source));
      this.record(source, 'created');
      return source;
    });
  }
  edit(projectId: string, id: string, input: unknown, key: string): ProjectSource {
    const previous = this.get(projectId, id, true); // Current permission precedes idempotent receipts.
    const data = parseSourceEdit(input, previous.kind);
    return this.store.mutate(`project.source.edit:${id}`, key, { projectId, ...data }, () => {
      const source = this.get(projectId, id, true);
      assertRevision(source.revision, data.expectedRevision);
      if (source.deletedAt)
        throw new DomainError('SOURCE_DELETED', '资料已删除，请明确恢复后再编辑', 409);
      const { expectedRevision: _revision, ...content } = data;
      const hash = contentHash(source.kind, content);
      if (hash === source.contentHash) return source;
      return this.save({ ...source, ...content, contentHash: hash }, 'updated');
    });
  }
  lifecycle(projectId: string, id: string, input: unknown, key: string): ProjectSource {
    this.get(projectId, id, true);
    const data = parseSourceLifecycle(input);
    return this.store.mutate(`project.source.lifecycle:${id}`, key, { projectId, ...data }, () => {
      const source = this.get(projectId, id, true);
      assertRevision(source.revision, data.expectedRevision);
      const deleted = data.action === 'delete';
      if (!!source.deletedAt === deleted) return source;
      return this.save(
        {
          ...source,
          deletedAt: deleted ? new Date().toISOString() : null,
          deletedByUserId: deleted ? this.store.actorId : null,
        },
        deleted ? 'deleted' : 'restored',
      );
    });
  }
  /** Called only inside the draft-adoption transaction; preserve source identity, title and URL. */
  adoptContent(projectId: string, id: string, expectedRevision: number, content: string) {
    const current = this.get(projectId, id, true);
    assertRevision(current.revision, expectedRevision);
    if (current.deletedAt)
      throw new DomainError('SOURCE_DELETED', '资料已删除，请选择有效目标', 409);
    const data = parseSourceEdit(
      { expectedRevision, title: current.title, content, url: current.url },
      current.kind,
    );
    const nextHash = contentHash(current.kind, data);
    if (nextHash === current.contentHash) return current;
    return this.save({ ...current, content: data.content, contentHash: nextHash }, 'updated');
  }
  private save(previous: ProjectSource, action: SourceRevision['action']): ProjectSource {
    const source = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserId: this.store.actorId,
      updatedByName: this.store.actorName(),
    };
    this.store.db
      .prepare('UPDATE project_sources SET body=? WHERE id=? AND project_id=? AND space_id=?')
      .run(JSON.stringify(source), source.id, source.projectId, source.spaceId);
    this.record(source, action);
    return source;
  }
  history(
    projectId: string,
    id: string,
    query: { before: number | null; limit: number },
  ): SourceRevisionPage {
    this.get(projectId, id);
    const rows = this.store.db
      .prepare(
        'SELECT action,body FROM project_source_revisions WHERE source_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?',
      )
      .all(id, query.before, query.before, query.limit + 1) as {
      action: SourceRevision['action'];
      body: string;
    }[];
    const items = rows
      .slice(0, query.limit)
      .map((row) => ({ action: row.action, source: decode(row) }));
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.source.revision : null };
  }
}
