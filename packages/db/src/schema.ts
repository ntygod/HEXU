/** Local-preview migration only. Production PostgreSQL is intentionally not implied. */
export const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id), body TEXT NOT NULL);
CREATE INDEX tasks_space ON tasks(space_id);
CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
CREATE INDEX messages_task ON messages(task_id);
CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
CREATE INDEX runs_task ON runs(task_id);
CREATE TABLE results (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
CREATE TABLE completion_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), actor_id TEXT NOT NULL, action TEXT NOT NULL, task_revision INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE idempotency_records (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,key));
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE native_workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
CREATE TABLE native_workspace_locks (working_copy_id TEXT PRIMARY KEY REFERENCES native_workspaces(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id));
CREATE TABLE native_run_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX native_events_run ON native_run_events(run_id, sequence);
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE continuation_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  working_copy_id TEXT NOT NULL REFERENCES native_workspaces(id),
  state TEXT NOT NULL CHECK(state IN ('waiting_for_stop','preparing','needs_attention','succeeded','cancelled','failed')),
  body TEXT NOT NULL
);
CREATE INDEX continuation_task ON continuation_operations(task_id);
CREATE UNIQUE INDEX continuation_active_task ON continuation_operations(task_id) WHERE state IN ('waiting_for_stop','preparing');
CREATE UNIQUE INDEX continuation_active_copy ON continuation_operations(working_copy_id) WHERE state IN ('waiting_for_stop','preparing');
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE collab_people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
CREATE TABLE collab_spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('personal','team')), created_at TEXT NOT NULL);
CREATE TABLE collab_memberships (space_id TEXT NOT NULL REFERENCES collab_spaces(id), user_id TEXT NOT NULL REFERENCES collab_people(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), PRIMARY KEY(space_id,user_id));
CREATE TABLE collab_project_members (project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES collab_people(id), role TEXT NOT NULL CHECK(role IN ('view','edit','manage')), PRIMARY KEY(project_id,user_id));
CREATE TABLE collab_invitations (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES collab_spaces(id), email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES collab_people(id), expires_at TEXT NOT NULL, accepted_by TEXT REFERENCES collab_people(id), revoked INTEGER NOT NULL DEFAULT 0);
ALTER TABLE outbox ADD COLUMN space_id TEXT;
CREATE INDEX collab_membership_user ON collab_memberships(user_id);
CREATE INDEX collab_project_member_user ON collab_project_members(user_id);
`,
  },
];
