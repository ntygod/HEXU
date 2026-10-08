# Agent assistance slice 2 backend verification

2026-10-08. Fictional disposable identities and local SQLite only. No external communication, model invocation, native execution, file apply, restore workflow, or browser-access retry was used.

## Implemented boundary

- The original Assistance remains the sole business authority, with open/responded/closed/cancelled states. Negotiation phase is derived from immutable current-input responses.
- Browser members explicitly preview/share one fixed message excerpt and optional same-project text sources. The fixed excerpt remains a required anchor in scope proposals; additional project text can be reduced. Private-task requests, links, files, diffs and implicit transcripts are unsupported.
- Independent request-bound credentials are explicitly issued/rotated/revoked by the recipient owner. Hash-only storage, once-only token return, finite expiry, material_read/respond scopes and a separate exact HTTP allowlist do not upgrade existing capability_read credentials.
- Token identity, responses, materials and errors omit parent task/project/source IDs and human owner IDs. Parent APIs remain unavailable to the token, even when its owner personally has project permissions.
- Automatic acceptance means a preauthorized business acceptance only. Atomic per-grant capacity reservations do not describe model execution or provider delivery.
- Access checks run before ID-only receipt lookup and again inside the write transaction. Input hashes/revisions, response CAS, finite input grants, responses, capacity, outbox and receipts commit atomically.
- Revocation/expiry/version changes permanently end dependent request access and release reservations. Close preserves reads; subsequent explicit cancellation revokes them. Stale source versions block accept/answer, while decline and requests for clarification can end or resolve the business negotiation without pretending a provider failed.
- The original human/Claude branches remain separate. External answers cannot use the old reply/adoption path or continue a Run.

## Verification performed

- Original server TypeScript configuration: ./node_modules/.bin/tsc -p tsconfig.server.json — passed.
- Prettier check of changed backend/contracts/identity/test files — passed.
- 47 tests across agent-assistance-contracts, agent-assistance-store, agent-assistance-http, assistance, ai-assistance, and assistance-adoption — passed.
  - 8 strict DTO/domain tests.
  - 12 real SQLite Store tests, including two separate SQLite connections racing for the final per-grant reservation (exactly one accepted), every persistence-stage injected rollback, immutable inputs, explicit text-source version checks, same-owner distinct participants, fixed-anchor proposals, close/cancel and old-key replay, and permanent expiry/archive/endpoint/capability/membership invalidation.
  - 1 real Better Auth + createApp + Store + Fastify.inject end-to-end test covering request-bound authentication, the clarification/input-revision/answer cycle with the same token, CAS conflicts, scope rotation/revocation, secret-once replay, old capability-token isolation, rejected parent APIs, full finite-view leakage assertions, and indistinguishable unknown/foreign request errors.
  - 26 ordinary adjacent human/Claude/adoption regression tests. No runner/real-provider suite was run.
- Existing agent-capabilities suite: initially 17 behavioral tests passed and the migration-history test failed because it hard-coded latest/count=36. Its final assertions preserve the complete original 1–36 sequence and uniqueness of all migration versions; the rerun passed 18/18. No production behavior was changed to satisfy the test.
- Original createApp/BetterAuth registration regression passed again: seven subtests plus the parent test, and the separate identity session test (Node reports 9 total). These remain distinct from the 47 negotiation/adjacent checks above.
- Migrations 1–36 were compared byte-for-byte with the slice-1 source and are unchanged. Prior schema SHA-256: d8c2fab9fd145212b7f24eadb9989dad3241a10c857b881ec468b6f89d5814c6. Only migration 37 was appended.

## Limits

This establishes request-bound finite-text negotiation and its actual local HTTP authentication boundary. It does not establish two autonomous heterogeneous Agents communicating over a real remote network, automatic result adoption, native-thread resume, or a browser visual acceptance run. UI verification is recorded separately. The verification commands do not create branches, PRs, main updates or deployments.
