# HEXU development instructions

Read `docs/product/03-functional-specification.md` and the relevant work package under `docs/development/` before changing behavior. Product v1.1 is authoritative; do not restore mandatory quality-evidence gates or create an AI-employee hierarchy.

## Approved product, design and client direction

Before changing UI or interaction, read `docs/design/README.md` (Workbench W1) and the relevant `02`/`10` work package. Before changing client packaging, deployment topology or local execution boundaries, also read `docs/engineering/adr-0008-client-surfaces.md`. These decisions supersede older light/indigo-first styling and web-only product assumptions; current delivered capabilities still come from `docs/development/21-implementation-status.md` and code.

- Serve both personal multi-tool/model coding and team AI coding. Personal work must not require enterprise registration or a team server. Keep one Task workspace for discussion, execution, context and results; do not split off a second AI-session task system.
- W1 is dark-first with cyan primary actions, a complete light theme, compact/comfortable density, a collapsible navigation rail/context guide, task-centered process/code panels, stable prompt controls and contextual drawers. Runtime values live in `packages/ui/src/tokens.css`; `docs/design/tokens.css` forwards to that single source. All W1 page surfaces now consume them; the old styles.css and palette aliases are removed. Keep foundation.css limited to base layout/form primitives and styles owned by their feature. Preserve explicit theme preferences and identity/space-scoped layout preferences. Drafts are provider-scoped memory only, cleared on identity/space change or revoked edit access. Do not recreate a second palette or monolithic presentation file.
- For the planned W1 frontend rebuild, read `docs/development/23-workbench-rebuild.md`. Legacy markup, layouts and styles may be replaced; preserve or explicitly rehome API, identity, permission, SSE, input and continuation behavior. Delete replaced presentation code after its route and behavior are covered by the new UI, not by clearing `apps/web`. Keep original work-item IDs and history; W1 subtasks do not reset delivered backend/provider work or make demo features real.
- The user has explicitly approved a complete W1 presentation rebuild. Reorganize all remaining pages/components/styles around the new design, then remove the old UI within W1-03—09; do not deliver a lasting mix of new skin on old layouts. Keep the delivered W1-01/02 foundation and migrate real behavior. Intermediate slices are implementation checkpoints, not a reason to stop before the approved rebuild is complete.
- Use Figma's selected-material assistance and handoff information structure, not its enterprise-only entry, task/session split, mandatory validation wording, automatic merge-on-selection or agent/member ranking. A reference demo is fictional and must never supply production state, tool capabilities or default model availability.
- The target is a desktop-primary client with an optional team service and a Web collaboration entry, sharing React UI, contracts and Task/Run/Operation rules. Keep Runner's process/credential/workspace responsibilities independent of the renderer and window lifetime. Electron vs Tauri is undecided; do not add either merely because a mockup mentions it. Web + Runner remains a valid delivery path.
- Preserve truthful task/run/code states, input delivery, cancellation and recovery. Native resume availability must follow the actual provider and node policy; new-session demos cannot override E2c1's explicit Codex recovery rules. Completion needs no report; selecting a parallel result does not merge or stop other work.
- Routine implementation choices remain autonomous. If an explicitly requested change revises this direction, update the same decision documents and relevant work items rather than creating a competing default. Do not claim desktop, remote or visual migration is complete from a design document.

## Current implementation

E2c1 has two loopback-only modes: **preview** preserves the fictional single-user native-tool workbench; **team-local** uses real accounts/project permissions and optional owner-authorized independent node execution, never the control host runtime. Neither is a hosted team platform. `docs/development/21-implementation-status.md` distinguishes actual, simulated and pending behavior. `mock` never spawns commands or calls a model. The experimental native provider calls an explicitly configured Claude Code CLI using API-key-authenticated bare/restricted file tools. Real-provider integration has not been exercised; protocol fixtures are never production agents. Codex is an experimental App Server provider with isolated temporary HOME/CODEX_HOME, API-key authentication over stdin, and explicit restricted configuration. The official 0.157.0 binary has passed no-model initialization/configuration checks; live model generation is still untested. Both providers can continue in the same local working copy via a new Run.

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

Persist bounded execution events before transport; ACK only committed matching sequence/hash. Revoked device credentials may settle only their already-bound dispatch, discarding output, never receive new commands. Terminal messages cannot complete a Task. Do not label independent node output as mock, or claim all startup phases were reached when a queued Run was cancelled. This remains loopback/POSIX owner execution with protocol fixtures; Codex retained-session resume is an experimental independent-node path; Claude resume, steer, delegated access, remote deployment and live-model verification are not delivered.

## E2b3 next-round inputs and node continuation

Next-round inputs are task-visible notes, never live model input or automatic dispatch. Only authors with current edit permission may alter queued notes. Selection revisions, source ownership/latest/confirmed stop, exact node/directory and material hash are checked inside Run creation. Bind notes and previousRunId in the same transaction as dispatch/idempotency. Mark started only on actual spawn; never claim provider receipt. Only clearly never-permitted cancellation can return notes to queued; ambiguous permitted launches retain bindings. New notes must not mutate or invalidate an already queued command.

The direct node /runs continuation remains 201+Run for compatibility. E2b4 UI uses the canonical 202 Operation route for fixed-material waiting. Adopt only source-dispatch output up to its first terminal event, with bounded final result/excerpts and chosen notes; no hidden-session migration. Keep next-round creation/reads/mutations under task permissions before idempotent replay. pending-executions exposes only local IDs/phases/counts, never prompts/keys and never changes locks.


## E2b4 durable node continuation

The node Operation freezes exactly the displayed material, selected note revisions and local policy. Do not silently append output produced after authorization. Actual files remain in the same authorized directory; this is not a checkpoint or native resume. Enforce pending task/node reservations in every start transaction, and recheck the owner's current permissions, source, note revisions, task/human context and policy before stopping or creating a Run. Only the source's automatic todo-to-in_progress transition may account for one expected revision increment.

Commit Run, dispatch, note binding, source link, Operation link, idempotency and outbox atomically. Cancellation does not retract an old stop signal; Operation success means Run creation only. Restart/expiry/context or policy changes pause plans and preserve material; never clear an unknown writer or retry paid work. Project editors may cancel pending plans, but only the node owner may schedule. Legacy preview records remain readable under parent-task permissions.


## E2c1 retained Codex sessions

Default stays ephemeral. Only locally confirmed Codex retainSessions:true enables a private per-session CODEX_HOME; preview and Claude stay unchanged. Bind recovery to node/control origin/project/task/directory identities, executable realpath, full policy/version/mode and an exact-key HMAC kept only in the local journal. Do not import personal sessions or accept browser thread IDs, history or paths. Public events contain only an opaque reference and restoration deadline, never the native transcript or account fingerprint.

Restore only the latest successful, termination-confirmed source, explicitly through a direct new Run; wait Operations remain new-session-only. Check metadata with thread/read, then thread/resume with restricted configuration, verify ID/cwd/model/approval/sandbox, and only then turn/start. Check cancellation before each next step. Failure never falls back to thread/start. Keep ready only after successful provider completion and confirmed process termination; interrupted state is blocked on restart. Seven days is a restore deadline, not deletion. Local cleanup requires confirmed terminal execution and does not delete task history or code. Raw native history must never be included in UI events.

Protocol fixtures exercise real process/HTTP/file mechanics, not real model generation. Document official no-model checks separately from fixture success and valid-account interoperability. Native history will be inherited during resume even if some current notes are unchecked; the UI must say this before consent.
