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
];
