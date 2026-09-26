import type { Project } from '../../contracts/src/index.js';
import {
  parseProjectPatch,
  type ProjectRevision,
  type ProjectRevisionPage,
} from '../../contracts/src/project.js';
import { assertRevision } from '../../domain/src/index.js';
import type { Store } from './store.js';

/** Project metadata only: never alters tasks, node grants, commands or working copies. */
export class ProjectSettingsStore {
  constructor(private readonly store: Store) {}

  record(
    project: Project,
    actorId: string | null,
    actorName: string | null,
    savedAt: string | null,
  ) {
    this.store.db
      .prepare(
        `INSERT INTO project_revisions
      (project_id,revision,name,description,actor_id,actor_name,saved_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        project.id,
        project.revision,
        project.name,
        project.description,
        actorId,
        actorName,
        savedAt,
      );
  }

  patch(id: string, input: unknown, key: string): Project {
    const check = () => {
      const project = this.store.project(id);
      if (this.store.teamMode) this.store.permissions.project(id, 'manage');
      return project;
    };
    check(); // Permission check must happen before idempotent replay, not just inside its action.
    const data = parseProjectPatch(input);
    return this.store.mutate(`project.patch:${id}`, key, data, () => {
      const current = check();
      assertRevision(current.revision, data.expectedRevision);
      // Do not persist request-scoped access or member lists into the project or replay snapshot.
      const { access: _access, memberIds: _members, ...project } = current;
      const name = data.name ?? project.name;
      const description = data.description ?? project.description;
      if (name === project.name && description === project.description) return project;
      const updated = { ...project, name, description, revision: project.revision + 1 };
      const savedAt = new Date().toISOString();
      this.store.db
        .prepare('UPDATE projects SET body=? WHERE id=? AND space_id=?')
        .run(JSON.stringify(updated), id, this.store.spaceId);
      this.record(updated, this.store.actorId, this.store.actorName(), savedAt);
      this.store.db
        .prepare(
          'INSERT INTO outbox(task_id,kind,created_at,space_id,project_id) VALUES(NULL,?,?,?,?)',
        )
        .run('project.updated', savedAt, this.store.spaceId, id);
      return updated;
    });
  }

  history(id: string, query: { limit: number; before: number | null }): ProjectRevisionPage {
    this.store.project(id); // History has exactly the same visibility as its parent project.
    const rows = this.store.db
      .prepare(
        `SELECT project_id AS projectId,revision,name,description,
      actor_id AS actorId,actor_name AS actorName,saved_at AS savedAt FROM project_revisions
      WHERE project_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?`,
      )
      .all(id, query.before, query.before, query.limit + 1) as unknown as ProjectRevision[];
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.revision : null };
  }
}
