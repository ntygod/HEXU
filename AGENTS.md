# HEXU development instructions

Read `docs/product/03-functional-specification.md` and the relevant work package under `docs/development/` before changing behavior. Product v1.1 is authoritative; do not restore mandatory quality-evidence gates or create an AI-employee hierarchy.

## Current implementation

E1b remains a **local single-user developer preview**, not a hosted team platform. `docs/development/21-implementation-status.md` distinguishes actual, simulated and pending behavior. `mock` never spawns commands or calls a model. The experimental native provider calls an explicitly configured Claude Code CLI using API-key-authenticated bare/restricted file tools. Real-provider integration has not been exercised; protocol fixtures are never production agents. Codex is an experimental App Server provider with isolated temporary HOME/CODEX_HOME, API-key authentication over stdin, and explicit restricted configuration. The official 0.157.0 binary has passed no-model initialization/configuration checks; live model generation is still untested. Both providers can continue in the same local working copy via a new Run.

## Structure

- `apps/web`: React/Vite UI; Task is the workspace entry point.
- `apps/control`: Fastify local API. Binding is loopback-only until real identity is implemented.
- `packages/contracts`: dependency-free request validation and DTOs.
- `packages/domain`: pure task/run rules. Must not import React, databases, or providers.
- `packages/db`: local-preview SQLite repository, migrations, transactions and outbox.
- `packages/adapters/mock`: deterministic simulator. Never spawn shell commands or call a model here.
- `packages/adapters/claude-code`: explicit JSONL parsing and restricted file-tool arguments; no bypass or hidden SDK/account fallback.
- `packages/adapters/codex`: bounded JSONL RPC; kebab-case thread sandbox vs camelCase turn sandbox; no raw reasoning or credentials in UI events.
- `apps/runner/src`: local hosted runtime, Git boundaries and POSIX process groups; not an independent daemon or remote node yet.
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
