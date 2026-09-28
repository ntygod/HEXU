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
  {
    version: 5,
    sql: `
CREATE TABLE runner_pairings (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES collab_people(id),
 space_id TEXT NOT NULL REFERENCES collab_spaces(id), project_id TEXT NOT NULL REFERENCES projects(id),
 code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
 node_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE runner_nodes (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES collab_people(id),
 space_id TEXT NOT NULL REFERENCES collab_spaces(id), project_id TEXT NOT NULL REFERENCES projects(id),
 token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL UNIQUE, registration_hash TEXT NOT NULL,
 name TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL, grants TEXT NOT NULL,
 created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, revoked_at TEXT,
 connection_id TEXT, server_epoch TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 last_seen_at TEXT, disconnected INTEGER NOT NULL DEFAULT 0,
 sequence INTEGER NOT NULL DEFAULT 0, event_hash TEXT, snapshot TEXT
);
CREATE INDEX runner_nodes_space ON runner_nodes(space_id,project_id);
CREATE INDEX runner_pairings_owner ON runner_pairings(owner_id);
CREATE TRIGGER runner_project_removed AFTER DELETE ON collab_project_members BEGIN
 UPDATE runner_nodes SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1
 WHERE owner_id=OLD.user_id AND project_id=OLD.project_id AND revoked_at IS NULL;
 UPDATE runner_pairings SET cancelled=1 WHERE owner_id=OLD.user_id AND project_id=OLD.project_id;
END;
CREATE TRIGGER runner_project_downgraded AFTER UPDATE OF role ON collab_project_members WHEN NEW.role='view' BEGIN
 UPDATE runner_nodes SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1
 WHERE owner_id=NEW.user_id AND project_id=NEW.project_id AND revoked_at IS NULL;
 UPDATE runner_pairings SET cancelled=1 WHERE owner_id=NEW.user_id AND project_id=NEW.project_id;
END;
CREATE TRIGGER runner_member_removed AFTER DELETE ON collab_memberships BEGIN
 UPDATE runner_nodes SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1
 WHERE owner_id=OLD.user_id AND space_id=OLD.space_id AND revoked_at IS NULL;
 UPDATE runner_pairings SET cancelled=1 WHERE owner_id=OLD.user_id AND space_id=OLD.space_id;
END;
`,
  },
  {
    version: 6,
    sql: `
CREATE TABLE node_execution_policies (
 node_id TEXT PRIMARY KEY REFERENCES runner_nodes(id), connection_id TEXT NOT NULL,
 policy_hash TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE node_dispatches (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 node_id TEXT NOT NULL REFERENCES runner_nodes(id), space_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, command TEXT NOT NULL,
 context_hash TEXT NOT NULL, task_revision INTEGER NOT NULL,
 stage TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0, last_hash TEXT,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_pending_node_dispatch ON node_dispatches(node_id) WHERE stage != 'terminal';
CREATE UNIQUE INDEX one_pending_task_dispatch ON node_dispatches(task_id) WHERE stage != 'terminal';
CREATE TABLE node_run_events (
 dispatch_id TEXT NOT NULL REFERENCES node_dispatches(id), sequence INTEGER NOT NULL,
 event_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(dispatch_id, sequence)
);
`,
  },
  {
    version: 7,
    sql: `
CREATE TABLE task_next_inputs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK(state IN ('queued','attached','started','cancelled')),
 target_run_id TEXT REFERENCES runs(id), body TEXT NOT NULL
);
CREATE INDEX next_inputs_task ON task_next_inputs(task_id,state);
CREATE INDEX next_inputs_target ON task_next_inputs(target_run_id,state);
CREATE TABLE node_continuation_links (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), source_run_id TEXT NOT NULL REFERENCES runs(id),
 preview_hash TEXT NOT NULL, input_ids TEXT NOT NULL
);
`,
  },
  {
    version: 8,
    sql: `
CREATE TABLE node_continuation_operations (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 node_id TEXT NOT NULL REFERENCES runner_nodes(id),
 state TEXT NOT NULL CHECK(state IN ('waiting_for_stop','preparing','needs_attention','succeeded','cancelled','failed')),
 body TEXT NOT NULL
);
CREATE INDEX node_continuation_task ON node_continuation_operations(task_id);
CREATE UNIQUE INDEX node_continuation_pending_task ON node_continuation_operations(task_id) WHERE state IN ('waiting_for_stop','preparing');
CREATE UNIQUE INDEX node_continuation_pending_node ON node_continuation_operations(node_id) WHERE state IN ('waiting_for_stop','preparing');
`,
  },
  {
    version: 9,
    sql: `
CREATE TABLE project_revisions (
 project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
 name TEXT NOT NULL, description TEXT NOT NULL, actor_id TEXT, actor_name TEXT, saved_at TEXT,
 PRIMARY KEY(project_id,revision)
);
-- Preserve the known snapshot only; older authors, dates and missing revisions are unknown.
INSERT INTO project_revisions(project_id,revision,name,description)
 SELECT id,json_extract(body,'$.revision'),json_extract(body,'$.name'),json_extract(body,'$.description') FROM projects;
ALTER TABLE outbox ADD COLUMN project_id TEXT REFERENCES projects(id);
`,
  },
  {
    version: 10,
    sql: `
ALTER TABLE project_revisions ADD COLUMN archived_at TEXT;
ALTER TABLE project_revisions ADD COLUMN archived_by TEXT;
`,
  },
  {
    version: 11,
    sql: `
CREATE TABLE task_assignment_events (
 task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
 from_user_id TEXT NOT NULL, from_name TEXT, to_user_id TEXT NOT NULL, to_name TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,revision)
);
-- Existing owners are not proof of who created a task or started its runs.
UPDATE tasks SET body=json_set(body,'$.createdByUserId',NULL)
 WHERE json_type(body,'$.createdByUserId') IS NULL;
UPDATE runs SET body=json_set(body,'$.createdByUserId',NULL)
 WHERE json_type(body,'$.createdByUserId') IS NULL;
`,
  },
  {
    version: 12,
    sql: `
CREATE TABLE task_participant_sets (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), revision INTEGER NOT NULL CHECK(revision>=1)
);
CREATE TABLE task_participants (
 task_id TEXT NOT NULL REFERENCES tasks(id), user_id TEXT NOT NULL, name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','left','removed','access_revoked')), updated_at TEXT NOT NULL,
 PRIMARY KEY(task_id,user_id)
);
CREATE INDEX task_participants_user ON task_participants(user_id,state,task_id);
CREATE TABLE task_participant_events (
 task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
 user_id TEXT NOT NULL, name TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('joined','added','left','removed','access_revoked')),
 actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,revision)
);
-- Legacy tasks start with an empty relation set; do not invent participation or authorship.
`,
  },
  {
    version: 13,
    sql: `
CREATE TABLE project_sources (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL
);
CREATE INDEX project_sources_project ON project_sources(project_id,space_id);
CREATE TABLE project_source_revisions (
 source_id TEXT NOT NULL REFERENCES project_sources(id), revision INTEGER NOT NULL CHECK(revision>=1),
 action TEXT NOT NULL CHECK(action IN ('created','updated','deleted','restored')), body TEXT NOT NULL,
 PRIMARY KEY(source_id,revision)
);
-- Do not relabel old project descriptions, messages or demo files as user-authored sources.
`,
  },
  {
    version: 14,
    sql: `
CREATE TABLE project_agreements (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL
);
CREATE INDEX project_agreements_project ON project_agreements(project_id,space_id);
CREATE TABLE project_agreement_revisions (
 agreement_id TEXT NOT NULL REFERENCES project_agreements(id), revision INTEGER NOT NULL CHECK(revision>=1),
 action TEXT NOT NULL CHECK(action IN ('created','updated','deactivated','reactivated','superseded')), body TEXT NOT NULL,
 PRIMARY KEY(agreement_id,revision)
);
CREATE TABLE project_agreement_versions (project_id TEXT PRIMARY KEY REFERENCES projects(id), version INTEGER NOT NULL);
-- Publication is explicit; no existing message, source or AI reply becomes an agreement on migration.
`,
  },
  {
    version: 15,
    sql: `
CREATE TABLE context_bundles (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL, created_by TEXT NOT NULL,
 run_id TEXT UNIQUE REFERENCES runs(id), operation_id TEXT UNIQUE, body TEXT NOT NULL,
 context_text TEXT, started_at TEXT
);
CREATE INDEX context_bundles_task ON context_bundles(task_id);
-- Existing runs and operations have no invented project-material snapshot or delivery receipt.
`,
  },
  {
    version: 16,
    sql: `
CREATE TABLE ai_drafts (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL
);
CREATE INDEX ai_drafts_task ON ai_drafts(task_id);
CREATE TABLE ai_draft_revisions (
 draft_id TEXT NOT NULL REFERENCES ai_drafts(id), revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL,
 PRIMARY KEY(draft_id,revision)
);
CREATE TABLE ai_draft_adoptions (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES ai_drafts(id), task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL
);
CREATE INDEX ai_draft_adoptions_draft ON ai_draft_adoptions(draft_id,task_id);
-- Existing AI replies are not silently converted to saved drafts or adopted content.
`,
  },
  {
    version: 17,
    sql: `
CREATE TABLE assistances (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
 requester_id TEXT NOT NULL, recipient_id TEXT NOT NULL, state TEXT NOT NULL,
 body TEXT NOT NULL, CHECK(state IN ('open','responded','closed','cancelled'))
);
CREATE INDEX assistances_task ON assistances(task_id,space_id);
CREATE INDEX assistances_recipient ON assistances(space_id,recipient_id,state);
CREATE INDEX assistances_requester ON assistances(space_id,requester_id,state);
CREATE TABLE assistance_grants (
 assistance_id TEXT PRIMARY KEY REFERENCES assistances(id), recipient_id TEXT NOT NULL,
 snapshot_hash TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope='snapshot_reply'), revoked_at TEXT
);
CREATE TABLE assistance_replies (
 assistance_id TEXT NOT NULL REFERENCES assistances(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(assistance_id,revision)
);
CREATE TABLE assistance_events (
 assistance_id TEXT NOT NULL REFERENCES assistances(id), revision INTEGER NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(assistance_id,revision)
);
ALTER TABLE outbox ADD COLUMN assistance_id TEXT REFERENCES assistances(id);
-- Existing messages and task memberships never imply consent to share an excerpt.
`,
  },
  {
    version: 18,
    sql: `
ALTER TABLE assistance_grants RENAME TO assistance_grants_v17;
CREATE TABLE assistance_grants (
 assistance_id TEXT PRIMARY KEY REFERENCES assistances(id), recipient_id TEXT NOT NULL,
 snapshot_hash TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('snapshot_reply','model_text')), revoked_at TEXT
);
INSERT INTO assistance_grants SELECT * FROM assistance_grants_v17;
DROP TABLE assistance_grants_v17;
-- No existing human consent is upgraded to model sending permission.
`,
  },
  {
    version: 19,
    sql: `
CREATE TABLE assistance_adoptions (
 id TEXT PRIMARY KEY, assistance_id TEXT NOT NULL REFERENCES assistances(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL
);
CREATE INDEX assistance_adoptions_scope ON assistance_adoptions(assistance_id,task_id);
-- Only explicit adoption writes history. Never infer adoption from an existing reply or grant.
`,
  },
  {
    version: 20,
    sql: `
CREATE TABLE checkpoint_requests (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL REFERENCES runner_nodes(id),
 owner_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','recorded','cancelled')), body TEXT NOT NULL,
 manifest_hash TEXT, checkpoint_id TEXT UNIQUE
);
CREATE INDEX checkpoint_requests_task ON checkpoint_requests(task_id);
CREATE TABLE commit_checkpoints (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL UNIQUE REFERENCES checkpoint_requests(id), body TEXT NOT NULL
);
-- No old summary, Run or message implies consent to publish a checkpoint.
`,
  },
  {
    version: 21,
    sql: `
CREATE TABLE checkpoint_retentions (
 id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES commit_checkpoints(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL REFERENCES runner_nodes(id),
 owner_id TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 manifest TEXT, sequence INTEGER NOT NULL DEFAULT 0, observed_at TEXT
);
CREATE INDEX checkpoint_retentions_scope ON checkpoint_retentions(checkpoint_id,task_id);
CREATE TABLE checkpoint_retention_reports (
 request_id TEXT NOT NULL REFERENCES checkpoint_retentions(id), sequence INTEGER NOT NULL,
 body_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(request_id,sequence)
);
-- Old references remain references; no fabricated object availability or retention consent.
`,
  },
  {
    version: 22,
    sql: `
CREATE TABLE checkpoint_restore_results (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES checkpoint_retentions(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
 body TEXT NOT NULL, body_hash TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE INDEX checkpoint_restore_results_scope ON checkpoint_restore_results(request_id,task_id);
CREATE TABLE checkpoint_restore_reports (
 restore_id TEXT NOT NULL REFERENCES checkpoint_restore_results(id), sequence INTEGER NOT NULL,
 body_hash TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL,
 PRIMARY KEY(restore_id,sequence)
);
-- Existing retentions never imply a file restore; only explicit node reports create observations.
`,
  },
  {
    version: 23,
    sql: `
CREATE TABLE checkpoint_transfers (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES checkpoint_retentions(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL, state TEXT NOT NULL,
 recipient_key TEXT, envelope TEXT, uploaded INTEGER NOT NULL DEFAULT 0, received_at TEXT
);
CREATE INDEX checkpoint_transfers_source ON checkpoint_transfers(source_id);
CREATE TABLE checkpoint_transfer_chunks (
 transfer_id TEXT NOT NULL REFERENCES checkpoint_transfers(id), sequence INTEGER NOT NULL,
 hash TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(transfer_id,sequence)
);
-- Ciphertext only. Existing retention/restore records imply no material transfer consent.
`,
  },
];
