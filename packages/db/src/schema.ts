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
  {
    version: 24,
    sql: `
ALTER TABLE checkpoint_restore_results ADD COLUMN transfer_id TEXT REFERENCES checkpoint_transfers(id);
CREATE INDEX checkpoint_restore_results_transfer ON checkpoint_restore_results(transfer_id);
-- NULL preserves original retention restores. Receiver restores keep the original
-- retention FK and an explicit transfer FK; no ticket/owner relabelling or old-data backfill.
`,
  },
  {
    version: 25,
    sql: `
CREATE TABLE handoffs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), space_id TEXT NOT NULL,
 transfer_id TEXT NOT NULL REFERENCES checkpoint_transfers(id), sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('offered','rejected','withdrawn','expired')),
 revision INTEGER NOT NULL CHECK(revision>=1), expires_at TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX handoffs_task ON handoffs(task_id);
CREATE INDEX handoffs_expiry ON handoffs(state,expires_at);
CREATE UNIQUE INDEX handoffs_active_transfer ON handoffs(transfer_id) WHERE state='offered';
CREATE TABLE handoff_events (
 handoff_id TEXT NOT NULL REFERENCES handoffs(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(handoff_id,revision)
);
-- Received objects and historical restore reports never automatically become an invitation or acceptance.
`,
  },
  {
    version: 26,
    sql: `
CREATE TABLE handoffs_v26 (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), space_id TEXT NOT NULL,
 transfer_id TEXT NOT NULL REFERENCES checkpoint_transfers(id), sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('offered','accepted','rejected','withdrawn','expired')),
 revision INTEGER NOT NULL CHECK(revision>=1), expires_at TEXT NOT NULL, body TEXT NOT NULL
);
INSERT INTO handoffs_v26 SELECT * FROM handoffs;
CREATE TABLE handoff_events_v26 (
 handoff_id TEXT NOT NULL REFERENCES handoffs_v26(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(handoff_id,revision)
);
INSERT INTO handoff_events_v26 SELECT * FROM handoff_events;
DROP TABLE handoff_events;
DROP TABLE handoffs;
ALTER TABLE handoffs_v26 RENAME TO handoffs;
ALTER TABLE handoff_events_v26 RENAME TO handoff_events;
CREATE INDEX handoffs_task ON handoffs(task_id);
CREATE INDEX handoffs_expiry ON handoffs(state,expires_at);
CREATE UNIQUE INDEX handoffs_active_transfer ON handoffs(transfer_id) WHERE state='offered';
CREATE TABLE handoff_acceptances (
 id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL REFERENCES runner_nodes(id),
 state TEXT NOT NULL CHECK(state IN ('waiting_local','needs_attention','succeeded','cancelled')), body TEXT NOT NULL
);
CREATE INDEX handoff_acceptances_handoff ON handoff_acceptances(handoff_id);
CREATE UNIQUE INDEX handoff_acceptance_pending_task ON handoff_acceptances(task_id) WHERE state='waiting_local';
-- No legacy operator/acceptance is inferred from ownership or a restore report.
`,
  },
  {
    version: 27,
    sql: `
CREATE TABLE work_branch_groups (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 checkpoint_id TEXT NOT NULL REFERENCES commit_checkpoints(id), body TEXT NOT NULL
);
CREATE INDEX work_branch_groups_task ON work_branch_groups(task_id);
CREATE TABLE work_branches (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 group_id TEXT NOT NULL REFERENCES work_branch_groups(id),
 state TEXT NOT NULL CHECK(state IN ('planned','discarded')),
 revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL
);
CREATE INDEX work_branches_group ON work_branches(group_id);
CREATE TABLE work_branch_events (
 branch_id TEXT NOT NULL REFERENCES work_branches(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(branch_id,revision)
);
-- Definition only: no legacy Run, directory, result or execution consent is backfilled.
`,
  },
  {
    version: 28,
    sql: `
CREATE TABLE work_branches_v28 (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 group_id TEXT NOT NULL REFERENCES work_branch_groups(id),
 state TEXT NOT NULL CHECK(state IN ('planned','active','discarded')),
 revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL
);
INSERT INTO work_branches_v28 SELECT * FROM work_branches;
CREATE TABLE work_branch_events_v28 (
 branch_id TEXT NOT NULL REFERENCES work_branches_v28(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(branch_id,revision)
);
INSERT INTO work_branch_events_v28 SELECT * FROM work_branch_events;
DROP TABLE work_branch_events;
DROP TABLE work_branches;
ALTER TABLE work_branches_v28 RENAME TO work_branches;
ALTER TABLE work_branch_events_v28 RENAME TO work_branch_events;
CREATE INDEX work_branches_group ON work_branches(group_id);
CREATE TABLE work_branch_workspaces (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES work_branches(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL,
 node_id TEXT, workspace_id TEXT, body TEXT NOT NULL
);
CREATE INDEX work_branch_workspaces_branch ON work_branch_workspaces(branch_id);
CREATE UNIQUE INDEX work_branch_workspace_active ON work_branch_workspaces(branch_id)
 WHERE state IN ('waiting_local','prepared','bound');
CREATE UNIQUE INDEX work_branch_workspace_binding ON work_branch_workspaces(node_id,workspace_id)
 WHERE state='bound';
DROP INDEX one_pending_task_dispatch;
CREATE UNIQUE INDEX one_pending_task_dispatch ON node_dispatches(task_id)
 WHERE stage!='terminal' AND json_extract(command,'$.workBranch.branchId') IS NULL;
CREATE UNIQUE INDEX one_pending_branch_dispatch ON node_dispatches(task_id,json_extract(command,'$.workBranch.branchId'))
 WHERE stage!='terminal' AND json_extract(command,'$.workBranch.branchId') IS NOT NULL;
-- Definitions stay unprepared until the original owner explicitly prepares and binds a new node.
`,
  },
  {
    version: 29,
    sql: `
CREATE TABLE work_branches_v29 (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 group_id TEXT NOT NULL REFERENCES work_branch_groups(id),
 state TEXT NOT NULL CHECK(state IN ('planned','active','ready','discarded')),
 revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL
);
INSERT INTO work_branches_v29 SELECT * FROM work_branches;
CREATE TABLE work_branch_events_v29 (
 branch_id TEXT NOT NULL REFERENCES work_branches_v29(id), revision INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(branch_id,revision)
);
INSERT INTO work_branch_events_v29 SELECT * FROM work_branch_events;
CREATE TABLE work_branch_workspaces_v29 (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES work_branches_v29(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL,
 node_id TEXT, workspace_id TEXT, body TEXT NOT NULL
);
INSERT INTO work_branch_workspaces_v29 SELECT * FROM work_branch_workspaces;
DROP TABLE work_branch_workspaces;
DROP TABLE work_branch_events;
DROP TABLE work_branches;
ALTER TABLE work_branches_v29 RENAME TO work_branches;
ALTER TABLE work_branch_events_v29 RENAME TO work_branch_events;
ALTER TABLE work_branch_workspaces_v29 RENAME TO work_branch_workspaces;
CREATE INDEX work_branches_group ON work_branches(group_id);
CREATE INDEX work_branch_workspaces_branch ON work_branch_workspaces(branch_id);
CREATE UNIQUE INDEX work_branch_workspace_active ON work_branch_workspaces(branch_id)
 WHERE state IN ('waiting_local','prepared','bound');
CREATE UNIQUE INDEX work_branch_workspace_binding ON work_branch_workspaces(node_id,workspace_id)
 WHERE state='bound';
CREATE TABLE result_revisions (
 id TEXT PRIMARY KEY, result_id TEXT NOT NULL REFERENCES results(id),
 revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL,
 UNIQUE(result_id,revision)
);
-- Preserve exactly the one known legacy version; never invent missing history or actors.
INSERT INTO result_revisions(id,result_id,revision,body)
 SELECT id || '-v' || json_extract(body,'$.revision'), id, json_extract(body,'$.revision'),
 json_object('id',id || '-v' || json_extract(body,'$.revision'),'resultId',id,
 'taskId',task_id,'revision',json_extract(body,'$.revision'),'title',json_extract(body,'$.title'),
 'body',json_extract(body,'$.body'),'kind',json_extract(body,'$.kind'),'limitations','',
 'source',json_object('kind','legacy'),'createdBy',NULL,'createdAt',json_extract(body,'$.updatedAt'))
 FROM results;
CREATE TRIGGER result_revisions_immutable_update BEFORE UPDATE ON result_revisions
 BEGIN SELECT RAISE(ABORT,'result revisions are immutable'); END;
CREATE TRIGGER result_revisions_immutable_delete BEFORE DELETE ON result_revisions
 BEGIN SELECT RAISE(ABORT,'result revisions are immutable'); END;
-- Null means an older terminal Run did not retain a reliable output boundary.
ALTER TABLE node_dispatches ADD COLUMN terminal_sequence INTEGER;
CREATE TABLE work_branch_choices (
 group_id TEXT NOT NULL REFERENCES work_branch_groups(id), revision INTEGER NOT NULL CHECK(revision>=1),
 branch_id TEXT REFERENCES work_branches(id), result_revision_id TEXT REFERENCES result_revisions(id),
 body TEXT NOT NULL, PRIMARY KEY(group_id,revision),
 CHECK((branch_id IS NULL)=(result_revision_id IS NULL))
);
CREATE TRIGGER work_branch_choices_immutable_update BEFORE UPDATE ON work_branch_choices
 BEGIN SELECT RAISE(ABORT,'branch choices are immutable'); END;
CREATE TRIGGER work_branch_choices_immutable_delete BEFORE DELETE ON work_branch_choices
 BEGIN SELECT RAISE(ABORT,'branch choices are immutable'); END;
-- selected is derived from this fixed-version choice, not a second mutable branch flag.
`,
  },
  {
    version: 30,
    sql: `
CREATE TABLE result_code_differences (
 revision_id TEXT PRIMARY KEY REFERENCES result_revisions(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 node_id TEXT NOT NULL REFERENCES runner_nodes(id), digest TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TRIGGER result_code_differences_immutable_update BEFORE UPDATE ON result_code_differences
 BEGIN SELECT RAISE(ABORT,'result code differences are immutable'); END;
CREATE TRIGGER result_code_differences_immutable_delete BEFORE DELETE ON result_code_differences
 BEGIN SELECT RAISE(ABORT,'result code differences are immutable'); END;
`,
  },
  {
    version: 31,
    sql: `
CREATE TABLE integration_operations (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 node_id TEXT NOT NULL REFERENCES runner_nodes(id),
 state TEXT NOT NULL CHECK(state IN ('queued','awaiting_choice','conflict','failed','cancelled')),
 revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL
);
CREATE INDEX integration_operations_task ON integration_operations(task_id);
CREATE TABLE integration_events (
 integration_id TEXT NOT NULL REFERENCES integration_operations(id), revision INTEGER NOT NULL,
 body TEXT NOT NULL, PRIMARY KEY(integration_id,revision)
);
CREATE TRIGGER integration_events_immutable_update BEFORE UPDATE ON integration_events
 BEGIN SELECT RAISE(ABORT,'integration events are immutable'); END;
CREATE TRIGGER integration_events_immutable_delete BEFORE DELETE ON integration_events
 BEGIN SELECT RAISE(ABORT,'integration events are immutable'); END;
CREATE TRIGGER integration_report_immutable BEFORE UPDATE ON integration_operations
 WHEN json_extract(OLD.body,'$.report') IS NOT NULL
 AND json_extract(OLD.body,'$.report') IS NOT json_extract(NEW.body,'$.report')
 BEGIN SELECT RAISE(ABORT,'integration reports are immutable'); END;
-- No existing Result, Run, restore or choice is relabelled as an integration.
`,
  },
  {
    version: 32,
    sql: `
-- Rebuild the CHECK without disabling foreign keys. Preserve dependent event rows
-- in a temporary table while replacing their parent and recreate all guards.
CREATE TABLE integration_operations_next (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 node_id TEXT NOT NULL REFERENCES runner_nodes(id),
 state TEXT NOT NULL CHECK(state IN ('queued','awaiting_choice','applying','completed','needs_attention','conflict','failed','cancelled')),
 revision INTEGER NOT NULL CHECK(revision>=1), body TEXT NOT NULL
);
INSERT INTO integration_operations_next SELECT * FROM integration_operations ORDER BY rowid;
CREATE TEMP TABLE integration_events_saved AS SELECT * FROM integration_events;
DROP TABLE integration_events;
DROP TABLE integration_operations;
ALTER TABLE integration_operations_next RENAME TO integration_operations;
CREATE INDEX integration_operations_task ON integration_operations(task_id);
CREATE TABLE integration_events (
 integration_id TEXT NOT NULL REFERENCES integration_operations(id), revision INTEGER NOT NULL,
 body TEXT NOT NULL, PRIMARY KEY(integration_id,revision)
);
INSERT INTO integration_events SELECT * FROM integration_events_saved;
DROP TABLE integration_events_saved;
CREATE TRIGGER integration_events_immutable_update BEFORE UPDATE ON integration_events
 BEGIN SELECT RAISE(ABORT,'integration events are immutable'); END;
CREATE TRIGGER integration_events_immutable_delete BEFORE DELETE ON integration_events
 BEGIN SELECT RAISE(ABORT,'integration events are immutable'); END;
CREATE TRIGGER integration_report_immutable BEFORE UPDATE ON integration_operations
 WHEN json_extract(OLD.body,'$.report') IS NOT NULL
 AND json_extract(OLD.body,'$.report') IS NOT json_extract(NEW.body,'$.report')
 BEGIN SELECT RAISE(ABORT,'integration reports are immutable'); END;
CREATE TRIGGER integration_application_immutable BEFORE UPDATE ON integration_operations
 WHEN json_extract(OLD.body,'$.application') IS NOT NULL AND (
 json_remove(json_extract(OLD.body,'$.application'),'$.reports')
 IS NOT json_remove(json_extract(NEW.body,'$.application'),'$.reports')
 OR json_array_length(NEW.body,'$.application.reports') IS NULL
 OR json_array_length(NEW.body,'$.application.reports') < json_array_length(OLD.body,'$.application.reports')
 OR (json_array_length(OLD.body,'$.application.reports') >= 1 AND
 json_extract(OLD.body,'$.application.reports[0]') IS NOT json_extract(NEW.body,'$.application.reports[0]'))
 OR (json_array_length(OLD.body,'$.application.reports') >= 2 AND
 json_extract(OLD.body,'$.application.reports[1]') IS NOT json_extract(NEW.body,'$.application.reports[1]')))
 BEGIN SELECT RAISE(ABORT,'integration application and reports are immutable'); END;
`,
  },
  {
    version: 33,
    sql: `
-- A separate historical observation never relabels the original application evidence.
CREATE TABLE integration_recovery_observations (
 integration_id TEXT PRIMARY KEY REFERENCES integration_operations(id),
 application_id TEXT NOT NULL UNIQUE, recovery_id TEXT NOT NULL UNIQUE,
 hash TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TRIGGER integration_recovery_immutable_update BEFORE UPDATE ON integration_recovery_observations
 BEGIN SELECT RAISE(ABORT,'integration recovery observations are immutable'); END;
CREATE TRIGGER integration_recovery_immutable_delete BEFORE DELETE ON integration_recovery_observations
 BEGIN SELECT RAISE(ABORT,'integration recovery observations are immutable'); END;
`,
  },
  {
    version: 34,
    sql: `
-- Candidate evidence is independent of original operation/application history.
CREATE TABLE integration_trial_differences (
 integration_id TEXT NOT NULL REFERENCES integration_operations(id),
 trial_id TEXT PRIMARY KEY, hash TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX integration_trials_history ON integration_trial_differences(integration_id,received_at DESC,trial_id DESC);
CREATE TRIGGER integration_trials_immutable_update BEFORE UPDATE ON integration_trial_differences
 BEGIN SELECT RAISE(ABORT,'integration trial differences are immutable'); END;
CREATE TRIGGER integration_trials_immutable_delete BEFORE DELETE ON integration_trial_differences
 BEGIN SELECT RAISE(ABORT,'integration trial differences are immutable'); END;
`,
  },
];
