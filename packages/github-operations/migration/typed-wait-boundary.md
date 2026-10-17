---
feature_ids: [F202]
topics: [github, plugins, tracking, migration]
doc_kind: implementation-checkpoint
created: 2026-10-09
---

# Typed wait migration checkpoint

Accepted scope: the 2026-09-21 F202 C1 contract and operator159/180
(Host thread_mu8dg6h7l2x4ohsk messages 0001791537709396-000159-bde3450e
and 0001791538243673-000180-2e869b26).
Tracking is plugin-owned native MCP; Host keeps generic SDK services.

The exact source move is commit 5697baf. The twelve source hashes in
typed-wait-source-map.json bind Host e95f2e14b1c511a977563a22e24f8e449a36a82d.
The following adaptation changes import/port boundaries independently:

- Predicate catalog, both baseline readers, renewal, state machine and rendering
  preserve their moved bodies. Lifecycle and recovery use package-local ports.
- The package model retains GitHub automation declarations, not unrelated Host
  task authority/deployment/dispatch fields. Wait state is private SDK storage.
- TaskAutomationState cursor merging also comes from the same frozen Host source.
- The lifecycle's notification call now maps to SDK messaging.send. Pending
  outcomes survive a failed send and reuse the task/outcome idempotency key.
- tracking-mcp-schemas.ts retains the original tracking fields and adds a required
  caller-generated registrationId to both registration tools for durable replay.
  tracking-mcp-server.ts preserves names and descriptions and exposes them through
  a native MCP server; handlers call package business, not old Host callbacks.
- typed-wait-registration.ts contains the prior route's predicate expansion,
  baseline/coverage-before-write, generation and pending-outcome preservation.
  Caller identity is not accepted in its tool input.

## Current runtime boundary

This is an implementation checkpoint, not an installed replacement. The alpha.14
manifest/runtime still uses the earlier tracking path. The new native MCP factory
and wait store are exercised independently but are not yet composed with the
installed provider/polling loop. Do not delete Host callers based on these tests.

Host pairing message 0001791538633208-000204-fef80d17 confirms existing native MCP
registration and config/secret environment injection. The remaining generic
connection is native MCP process to SDK Host services; it must not reuse MCP stdout
for broker frames or forward raw Host callback credentials. Host owns that edge.
No new GitHub proof/issuer layer, plugin_call tool, or per-version approval is needed.

Next in the same W3 implementation: compose provider collection, registration,
private state, recovery and schedules; consume the Host generic SDK connection;
declare the actual MCP entrypoint; then install from a local directory in the
isolated Host and prove old caller absence/no double run plus disable/reload.

The dependency lock copies the existing workspace Zod 3.25.76 and MCP SDK 1.26.0
closure. It needs new packed-consumer validation before an installable version
is frozen. No alpha.14 gate or prior Host acceptance is transferred.

## Review 255 corrections

- Wait delivery explicitly selects the declared github-wait identity. The other
  senders explicitly select github-notification, so adding a second identity
  introduces no implicit selection. A real Host messaging service/store projection
  regression verifies that its continuation parser accepts the resulting carrier.
- Registration tools require one unique registrationId per intent. Exact retries
  reuse the ID and arguments; an intentional replacement uses a new ID.
  registerPrWait/registerIssueWait read committed receipts before provider lookup.
  A reused ID with changed input or owner is refused. Receipt and wait state share
  one private storage CAS; later collector writes preserve the receipt.
- The same CAS appends any superseded lifecycle event, independently of an older
  pending delivery. Both remain persisted across restart; neither has a TTL.
- PR nextStep is trimmed and whitespace-only input is rejected.

These are package implementation corrections. Native MCP authentication and
installed polling/lifecycle composition remain pending; no production caller is
retired by this checkpoint.
