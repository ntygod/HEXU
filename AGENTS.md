# HEXU development instructions

Read `docs/product/03-functional-specification.md` and the relevant work package under `docs/development/` before changing behavior. Product v1.1 is authoritative; do not restore mandatory quality-evidence gates or create an AI-employee hierarchy.

## Current implementation

E0 is a **local developer preview**, not a hosted team platform. `docs/development/21-implementation-status.md` distinguishes implemented, simulated and pending capabilities. The only execution provider is `mock`. A label naming Claude Code or Codex in the simulator is NOT a native integration. Do not remove this distinction to make a demo look complete.

## Structure

- `apps/web`: React/Vite UI; Task is the workspace entry point.
- `apps/control`: Fastify local API. Binding is loopback-only until real identity is implemented.
- `packages/contracts`: dependency-free request validation and DTOs.
- `packages/domain`: pure task/run rules. Must not import React, databases, or providers.
- `packages/db`: local-preview SQLite repository, migrations, transactions and outbox.
- `packages/adapters/mock`: deterministic simulator. Never spawn shell commands or call a model here.
- `packages/ui`: visual tokens and shared components.
- `packages/client`: browser HTTP client.

All services currently use explicit `.js` import specifiers for TypeScript compilation. Keep business state separate from execution state. Idempotency records, changes and outbox entries are atomic; stale revisions return 409. Stop requests are not termination confirmation. A task can be completed without a report.

## Commands

Use Node 24 and npm. `npm ci`, `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`. Run `npm run format` before committing. Browser tests use a separate disposable `.hexu/e2e` database, never the user's main data.

Keep source credentials, local databases, screenshots containing real data and `.env` out of Git. Public fixtures must remain fictional. Do not expose local-preview via a tunnel, reverse proxy or 0.0.0.0 binding as a substitute for authentication. Do not add an unrequested license or change repository settings.

Implement small vertical slices. Update the implementation-status document with actual scope and test results, not claims based on documents or mock output. Preserve the original development task IDs and record partial work honestly.
