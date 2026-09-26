# HEXU development instructions

Read `docs/product/03-functional-specification.md` and the relevant work package under `docs/development/` before changing behavior. Product v1.1 is authoritative; do not restore mandatory quality-evidence gates or create an AI-employee hierarchy.

When taking over development, start with `docs/development/24-ai-handoff.md`. Current capabilities and checks are in `21-implementation-status.md`; the next delivery is in `22-next-delivery.md`. W1-01—09 is delivered, so do not restart the completed UI migration from older planning text. Optional ignored `.hexu/local-environment.md` records machine-local preview/test details, not portable product capabilities.

## Approved product, design and client direction

Before changing UI or interaction, read `docs/design/README.md` (Workbench W1) and the relevant `02`/`10` work package. Before changing client packaging, deployment topology or local execution boundaries, also read `docs/engineering/adr-0008-client-surfaces.md`. These decisions supersede older light/indigo-first styling and web-only product assumptions; current delivered capabilities still come from `docs/development/21-implementation-status.md` and code.

- Serve both personal multi-tool/model coding and team AI coding. Personal work must not require enterprise registration or a team server. Keep one Task workspace for discussion, execution, context and results; do not split off a second AI-session task system.
- W1 is dark-first with cyan primary actions, a complete light theme, compact/comfortable density, a collapsible navigation rail/context guide, task-centered process/code panels, stable prompt controls and contextual drawers. Runtime values live in `packages/ui/src/tokens.css`; `docs/design/tokens.css` forwards to that single source. All W1 page surfaces now consume them; the old styles.css and palette aliases are removed. Keep foundation.css limited to base layout/form primitives and styles owned by their feature. Preserve explicit theme preferences and identity/space-scoped layout preferences. Drafts are provider-scoped memory only, cleared on identity/space change or revoked edit access. Do not recreate a second palette or monolithic presentation file.
- For the planned W1 frontend rebuild, read `docs/development/23-workbench-rebuild.md`. Legacy markup, layouts and styles may be replaced; preserve or explicitly rehome API, identity, permission, SSE, input and continuation behavior. Delete replaced presentation code after its route and behavior are covered by the new UI, not by clearing `apps/web`. Keep original work-item IDs and history; W1 subtasks do not reset delivered backend/provider work or make demo features real.
- The user has explicitly approved a complete W1 presentation rebuild. Reorganize all remaining pages/components/styles around the new design, then remove the old UI within W1-03—09; do not deliver a lasting mix of new skin on old layouts. Keep the delivered W1-01/02 foundation and migrate real behavior. Intermediate slices are implementation checkpoints, not a reason to stop before the approved rebuild is complete.
- Use Figma's selected-material assistance and handoff information structure, not its enterprise-only entry, task/session split, mandatory validation wording, automatic merge-on-selection or agent/member ranking. A reference demo is fictional and must never supply production state, tool capabilities or default model availability.
- The target is a desktop-primary client with an optional team service and a Web collaboration entry, sharing React UI, contracts and Task/Run/Operation rules. Keep Runner's process/credential/workspace responsibilities independent of the renderer and window lifetime. Electron vs Tauri is undecided; do not add either merely because a mockup mentions it. Web + Runner remains a valid delivery path.
- Preserve truthful task/run/code states, input delivery, cancellation and recovery. Native resume availability must follow the actual provider and node policy; new-session demos cannot override E2c2's explicit provider-specific recovery rules. Completion needs no report; selecting a parallel result does not merge or stop other work.
- Routine implementation choices remain autonomous. If an explicitly requested change revises this direction, update the same decision documents and relevant work items rather than creating a competing default. Do not claim desktop, remote or visual migration is complete from a design document.

## Current implementation

E2c2 has two loopback-only modes: **preview** preserves the fictional single-user native-tool workbench; **team-local** uses real accounts/project permissions and optional owner-authorized independent node execution, never the control host runtime. Neither is a hosted team platform. `docs/development/21-implementation-status.md` distinguishes actual, simulated and pending behavior. `mock` never spawns commands or calls a model. The experimental native provider calls an explicitly configured Claude Code CLI using API-key-authenticated bare/restricted file tools. Real-provider integration has not been exercised; protocol fixtures are never production agents. Codex is an experimental App Server provider with isolated temporary HOME/CODEX_HOME, API-key authentication over stdin, and explicit restricted configuration. The official 0.157.0 binary has passed no-model initialization/configuration checks; live model generation is still untested. Both providers can continue in the same local working copy via a new Run.

## Structure

- `apps/web`: React/Vite UI; Task is the workspace entry point.
- `apps/control`: Fastify local API. Binding stays loopback-only even with real identities until independent nodes and remote deployment controls are implemented.
- `packages/contracts`: dependency-free request validation and DTOs.
- `packages/domain`: pure task/run rules. Must not import React, databases, or providers.
- `packages/db`: mode-separated SQLite repository, request-scoped permissions, migrations, transactions and outbox.
- `packages/adapters/mock`: deterministic simulator. Never spawn shell commands or call a model here.
- `packages/adapters/claude-code`: explicit JSONL parsing and restricted file-tool arguments; no bypass or hidden SDK/account fallback.
- `packages/adapters/codex`: bounded JSONL RPC; kebab-case thread sandbox vs camelCase turn sandbox; no raw reasoning or credentials in UI events.
- `apps/runner/src`: preview hosted native runtime plus the independent CLI in cli.ts/agent. Default metadata; optional owner-only restricted task execution. No cross-computer deployment yet.
- `packages/ui`: visual tokens and shared components.
- `packages/client`: browser HTTP client.

All services currently use explicit `.js` import specifiers for TypeScript compilation. Keep business state separate from execution state. Idempotency records, changes and outbox entries are atomic; stale revisions return 409. Stop requests are not termination confirmation. A task can be completed without a report.

## Commands

Use Node 24 and npm. `npm ci`, `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`. Run `npm run format` before committing. Browser tests use a separate disposable `.hexu/e2e` database, never the user's main data.

Keep source credentials, local databases, screenshots containing real data and `.env` out of Git. Public fixtures must remain fictional. Do not expose local-preview via a tunnel, reverse proxy or 0.0.0.0 binding as a substitute for authentication. Do not add an unrequested license or change repository settings.

Implement small vertical slices. Update the implementation-status document with actual scope and test results, not claims based on documents or mock output. Preserve the original development task IDs and record partial work honestly.

## Native execution boundaries

Native mode is opt-in via local environment and explicit Git roots. Browser requests cannot register arbitrary paths or executable names. Do not enable Bash, MCP, repository hooks, subscription pooling or new network tools merely to make a task succeed. Native tool policies are not an OS sandbox. Preserve working-copy locks when stop cannot be confirmed; never signal a stale persisted PID after restart. Only the offline recovery command accepts the operator's explicit stopped-process confirmation. Task completion still requires no quality report.

Tests must override inherited native settings with a clearly named protocol fixture and fake key. Never use developer/provider credentials in CI. Document Linux-tested, macOS-unverified and Windows-unsupported boundaries. Keep capability detection separate from credential validity and actual model interoperability.

Continuation must preserve the explicit source Run and working-copy identity. Reject stale/foreign sources and active or uncertain writers; no implicit reset, stash, commit, upload, or identity transfer. Codex uses a separate OPENAI_API_KEY; do not forward it to Claude. Empty Hooks in Codex config are named empty arrays, not necessarily an empty object. Use an inline TOML projects map so dotted path overrides do not quote directory names incorrectly. Optional `check:codex-protocol` never authenticates or starts a model turn.

## Durable continuation

ContinuationOperation is distinct from both Task and Run. Its succeeded state means a Run was committed, not successful model work. Keep pending task/working-copy reservations and check them in every start route. Commit the Run, working-copy lock, idempotency result and operation link atomically before spawning. Recheck cancellation and human context immediately before commit. A stop request is not termination confirmation. On restart keep unknown process locks and mark pending operations needs_attention; never automatically replay paid execution. Preserve every original work-item ID and maintain the state/evidence/remaining columns in docs/development/19-work-items.md.

## E2a identity boundary

The default preview remains single-user and fictional. Optional team-local uses Better Auth 1.7.6, real users and explicit project roles, but stays loopback-only. It never initializes host native resources or accepts mock/native execution dispatch. Only the separate owner-authorized node provider may dispatch work; native/mock control-host dispatch remains forbidden. Preserve separate preview/business/auth databases; do not relabel or seed preview data as team data.

Use request-scoped principals and PermissionService for direct objects, lists, search, SSE and idempotent replays. Space ownership is not access to another person's private task or every project. Check permissions before returning stored idempotent results. Revalidate session and membership during event delivery; clear old UI data on revocation or identity changes. Keep session tokens out of browser storage/JSON, secrets out of logs, and invitation tokens hash-only at rest. Do not expose the full authentication handler or unrestricted signup. Email verification, password recovery and production/remote security remain incomplete; see team-local.md.

## E2b1 node metadata boundary

Node pairing authorizes only a fixed project and locally confirmed Git summary directories, never task execution. Keep browser Cookie and node Bearer channels separate. Server stores code/token hashes only; client credentials are fsynced before pairing exchange into a private state directory outside repositories. Do not upload absolute paths, filenames, code, branch/remotes, environment or provider keys. Never turn the summary endpoint into arbitrary RPC/command dispatch.

Preserve permanent node revocation on project/space removal; rejoining cannot revive credentials. Recheck project visibility for node metadata, even when the requester originally owned a revoked node. Connection presence is not Run state. A snapshot ACK means committed metadata, not accepted model work. Bounded local spool and exact sequence/hash replay must survive dropped replies; fail closed on divergence. Restart cannot spawn a model or signal a stale PID. Current protocol remains loopback HTTP and POSIX credentials; Windows, remote WSS/HTTPS and system credential storage are incomplete.

## E2b2 independent execution

Metadata pairing remains metadata-only. enable-execution adds a separate locally confirmed bounded policy; only the node owner can dispatch to that node. Team control must never initialize host native resources or receive provider keys. Project editors may stop existing project executions; viewing a project is not permission to launch on another machine. Keep Cookie and Bearer channels separate and preserve strict request schemas.

Commit Run/dispatch/input/idempotency/outbox atomically. Journal accepted before ACK, preparing before requesting the one-use permit, and running only from actual spawn. Never replay launch permission or spawn a command already in the local journal. Persist overlapping-workspace claims shared with preview; crashes do not clear claims. Unknown process state requires explicit local stopped-process confirmation, never a stale PID signal or lease expiry. Unsettled evidence blocks credential deletion/re-pairing.

Persist bounded execution events before transport; ACK only committed matching sequence/hash. Revoked device credentials may settle only their already-bound dispatch, discarding output, never receive new commands. Terminal messages cannot complete a Task. Do not label independent node output as mock, or claim all startup phases were reached when a queued Run was cancelled. This remains loopback/POSIX owner execution with protocol fixtures; Claude/Codex retained-session resume are experimental independent-node paths; steer, delegated access, remote deployment and live-model verification are not delivered.

## E2b3 next-round inputs and node continuation

Next-round inputs are task-visible notes, never live model input or automatic dispatch. Only authors with current edit permission may alter queued notes. Selection revisions, source ownership/latest/confirmed stop, exact node/directory and material hash are checked inside Run creation. Bind notes and previousRunId in the same transaction as dispatch/idempotency. Mark started only on actual spawn; never claim provider receipt. Only clearly never-permitted cancellation can return notes to queued; ambiguous permitted launches retain bindings. New notes must not mutate or invalidate an already queued command.

The direct node /runs continuation remains 201+Run for compatibility. E2b4 UI uses the canonical 202 Operation route for fixed-material waiting. Adopt only source-dispatch output up to its first terminal event, with bounded final result/excerpts and chosen notes; no hidden-session migration. Keep next-round creation/reads/mutations under task permissions before idempotent replay. pending-executions exposes only local IDs/phases/counts, never prompts/keys and never changes locks.


## E2b4 durable node continuation

The node Operation freezes exactly the displayed material, selected note revisions and local policy. Do not silently append output produced after authorization. Actual files remain in the same authorized directory; this is not a checkpoint or native resume. Enforce pending task/node reservations in every start transaction, and recheck the owner's current permissions, source, note revisions, task/human context and policy before stopping or creating a Run. Only the source's automatic todo-to-in_progress transition may account for one expected revision increment.

Commit Run, dispatch, note binding, source link, Operation link, idempotency and outbox atomically. Cancellation does not retract an old stop signal; Operation success means Run creation only. Restart/expiry/context or policy changes pause plans and preserve material; never clear an unknown writer or retry paid work. Project editors may cancel pending plans, but only the node owner may schedule. Legacy preview records remain readable under parent-task permissions.


## E2c1 retained Codex sessions

Default stays ephemeral. Only locally confirmed Codex retainSessions:true enables a private per-session CODEX_HOME; preview remains ephemeral; Claude has its own opt-in vault below. Bind recovery to node/control origin/project/task/directory identities, executable realpath, full policy/version/mode and an exact-key HMAC kept only in the local journal. Do not import personal sessions or accept browser thread IDs, history or paths. Public events contain only an opaque reference and restoration deadline, never the native transcript or account fingerprint.

Restore only the latest successful, termination-confirmed source, explicitly through a direct new Run; wait Operations remain new-session-only. Check metadata with thread/read, then thread/resume with restricted configuration, verify ID/cwd/model/approval/sandbox, and only then turn/start. Check cancellation before each next step. Failure never falls back to thread/start. Keep ready only after successful provider completion and confirmed process termination; interrupted state is blocked on restart. Seven days is a restore deadline, not deletion. Local cleanup requires confirmed terminal execution and does not delete task history or code. Raw native history must never be included in UI events.

Protocol fixtures exercise real process/HTTP/file mechanics, not real model generation. Document official no-model checks separately from fixture success and valid-account interoperability. Native history will be inherited during resume even if some current notes are unchecked; the UI must say this before consent.


## E2c2 retained Claude sessions

Default Claude/preview arguments include --no-session-persistence. Only local retainSessions:true enables a private HOME + CLAUDE_CONFIG_DIR and CLAUDE_CODE_PROJECT_DIR_NAME=work. Generate a UUID locally; use --session-id for creation and only that UUID with --resume. Never use personal HOME, imported history, --continue, names, user paths or fork-session. Keep the same binding/latest-success/terminal requirements as Codex but never copy its RPC protocol.

Keep Claude native transcript format opaque. Check the documented private transcript location and bounded whole-vault content fingerprint before resume; persist ready only after matching init/result/model and confirmed process termination with files synced. Keep metadata and provider IDs local. File limits (4096 entries/64 MiB/depth 16) are checks, not a continuous quota. Both providers have separate 32-record capacity. Account/key rotation or modified history requires explicit new work.

Validate init ID/cwd/model/dontAsk/tools/empty MCP before accepting session output; resumed model is pinned to the saved resolved model. ID checks do not prove no model request occurred before init; do not claim zero charge after process launch. Failure/stop/unknown never silently starts a fresh paid turn or clears workspace claims. Optional check:claude-protocol uses no key and a nonexistent UUID, not a real successful session. The exact 2.1.283 hidden --max-turns help exception cannot waive restriction flags or become a blanket version claim.

Project name/description editing (03-04) and archive/restore with execution controls (03-06) are implemented as local slices; continue task ownership/participants via the existing 22-next-delivery plan. Do not repeat W1 or block product development on unavailable live-provider credentials.

## Project settings

Project metadata edits require current project manage permission before replay and inside the transaction. Strictly accept name/description/expectedRevision; never persist request-scoped access or memberIds. The project update, immutable revision snapshot, project-scoped outbox event and idempotent receipt commit together. Old database migration records only the known snapshot with unknown author/time, not invented history. History and SSE use the parent's current access rules.

Keep the edit baseline fixed while the drawer is open. SSE updates show a comparison without replacing the draft or silently rebasing. Uncertain replies reuse the exact original payload/key when the user confirms; never infer that closing a drawer cancels a sent request. Drafts are drawer-local memory, cleared on close/refresh/identity or space changes and revoked manage access. Project edits do not update tasks, nodes, frozen material or running models. Archive/restore uses the separate lifecycle endpoint and the same project revision, never metadata PATCH.


## Project archive and restore

Archive is a barrier for new model work, not deletion or a blanket read-only state for human collaboration. Require current project manage permission before replay and inside the revision-checked transaction. Commit project state/history/outbox, cancellation of never-permitted node dispatches and suspension of every pending preview/node Operation together. Preserve fixed Operation material; immediate restore never revives old plans. Only unpermitted cancellation returns selected notes to queued.

Explicit keep/stop applies to already-permitted/started runs. Stop only runs in tasks the caller can currently edit; activity summaries must not reveal private tasks. Unknown/permitted writers retain claims and require actual termination evidence. Preparing preview execution is invalidated durably; also check after async directory preparation and immediately before Codex spawn. Revalidate project state at direct Run creation, idempotent replay, node permit and final continuation commit. Restore must not replay work, reissue permits, revive revoked node credentials, or clear writer locks.

Keep archive controls in the W1 project-settings drawer with explicit impact/stop choice and same-request receipt recovery. Archived tasks keep discussion/results/manual status and stop actions; disable and close execution/resume/reconfigure panels after the project-scoped SSE update. Project list filtering must not hide ongoing runs from task/workbench views. Do not reinterpret archive as OS process termination or as a new remote-deployment feature.

## Task assignment (04-01)

Project-visible task assignment is a separate semantic command, never a generic PATCH or implicit sharing path. Revalidate task edit access before idempotent replay and in the transaction; the target must be a current space/project edit/manage member. Assignment is responsibility, not an access grant or node/credential/history transfer. Preserve new Task/Run createdByUserId separately from ownerUserId; leave legacy identity unknown, never infer it from the current owner.

Commit Task revision, immutable assignment event, pending preview/node Operation suspension, scoped outbox and receipt atomically. Preserve frozen material, existing Run/dispatch identity and unknown workspace claims. Do not stop active runs, send live input, issue a permit or spawn paid work from assignment. Unpermitted old dispatches remain subject to task revision checks; keep their original command, do not silently rebase. Archived projects still allow this human-only collaboration. Old receipts must not repeat any side effect.

The task-assignment feature owns its W1 drawer/styles. Fix the edit baseline; SSE can flag changed tasks or invalid candidates but cannot replace a selection or implicitly raise expectedRevision. Uncertain results retry the identical payload/key only on explicit confirmation. Close/refresh/identity-space changes or revoked edit permission discard local editor state. Display unavailable owners honestly from current membership or recorded task-scoped history, never query unrelated private people as an assignment candidate. Next work is participants and scoped filtering, not another task/session system.
