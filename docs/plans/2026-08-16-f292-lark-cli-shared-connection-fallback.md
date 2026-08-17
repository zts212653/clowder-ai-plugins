---
feature_ids: [F292, K-2]
topics: [feishu, lark-cli, meeting-intake, event-conflict, polling]
doc_kind: plan
created: 2026-08-16
---

# F292 shared Feishu connection fallback plan

## Authority, baseline, and finish line

**Baseline:** `clowder-ai-plugins/main@c810403` and the installed Cat Café
runtime after `cat-cafe#3717` (`ddc4f47`).

**Observed conflict:** Cat Café already owns the same Feishu application's
WebSocket connection for native IM delivery. Starting a second
`lark-cli event consume` process therefore returns the typed
`EVENT_BUS_CONFLICT`. This is not an unknown machine and must not be handed to
the operator as a device-cleanup task.

**Finish line:** when and only when event-source startup fails with the exact
typed conflict, the official plugin closes every partially opened event child,
reuses the existing `lark-cli --as user` authorization, and becomes ready on a
bounded read-only Minutes/VC polling source. New generated artifacts are
published once through the existing durable outbox without flooding historical
artifacts. Authentication, permission, rate-limit, malformed-response, and
ordinary availability failures remain honest failures rather than fallback
triggers.

Terminal evidence is:

- focused package tests pass, including the exact conflict reproduction;
- package build/typecheck/lint pass;
- the packed runtime activates beside Cat Café's native Feishu WebSocket;
- one newly generated real meeting artifact reaches the F292 intake path, or
  the remote service returns a new typed blocker with the plugin remaining
  stopped/degraded honestly.

## Scope fence

In scope:

- Preserve WebSocket events as the preferred low-latency source.
- Add a package-owned polling source for Minutes search/detail and VC
  search/detail using the existing user profile.
- Switch to polling only for `EVENT_BUS_CONFLICT` and close partial event
  consumers before declaring polling ready.
- Store a versioned polling watermark in the existing cursor field and use the
  existing outbox/idempotency boundary for crash-safe redelivery.
- Bound pages, time windows, response sizes, poll cadence, and first-start
  lookback.

Out of scope:

- A generic Host event bus or raw vendor-event broker contract.
- Stopping Cat Café's native Feishu WebSocket.
- A new credential store, bot credential fallback, or browser-session reuse.
- Historical bulk import. Manual import remains the explicit recovery path.

## Stateful object census

| Object | Owner | Durable | Transition authority |
| --- | --- | --- | --- |
| source mode (`events` / `polling`) | gateway process | no | startup classifier |
| event consumers and abort controller | event gateway | no | event gateway close/failure |
| polling watermark cursor | existing state store | yes | successful page commit only |
| pending publish outbox | existing state store | yes | runtime commit/ack only |
| source health | existing state store | yes | runtime typed failure/success |
| CLI user profile and tokens | `lark-cli` | yes, outside plugin | `lark-cli`; plugin only supplies `HOME` |

No second durable cursor or credential copy is introduced.

## Source state machine

| From | Input | To | Required side effects |
| --- | --- | --- | --- |
| unopened | both event consumers ready | events-ready | keep both consumers |
| unopened / partial-events | exact `EVENT_BUS_CONFLICT` | polling-bootstrap | close all opened consumers; start no new event child |
| unopened / partial-events | any other failure | failed | close partial consumers; preserve typed error |
| polling-bootstrap | valid bounded read probes | polling-ready | baseline cursor at `now - lookback`; do not enumerate older history |
| polling-ready | successful page | polling-ready | atomically commit events and next watermark |
| polling-ready | auth/permission/rate/API failure | failed | record typed health; do not advance cursor |
| any live state | close/abort | closed | abort waits and terminate children |

## Polling contract

1. Use the bundled CLI entrypoint with `HOME=<host home>` and `--as user`.
   Never inherit arbitrary Host environment variables.
2. Search Minutes twice (`owner-ids=me` and `participant-ids=me`) because the
   API defines those result sets independently; union by minute token.
3. Search ended VC meetings in the same bounded window and batch detail calls
   to discover note/minute tokens that are not returned by Minutes search.
4. Inspect each new token through read-only detail commands before producing a
   descriptor. Descriptors contain only bounded IDs, revision, observation
   time, optional title, and optional meeting ID—never transcript content or
   destination authority.
5. Cursor grammar is `poll-v1:<unix-ms>`. A null cursor bootstraps to a small
   overlap before current time. Later polls overlap the previous watermark;
   stable descriptor revisions plus the durable outbox make overlap safe.
6. Each list call blocks for the configured poll interval when no page is
   ready, so the stdio runtime cannot hot-loop.

## Invariants and adversarial cases

- An exact conflict is the sole fallback edge; string matching arbitrary
  stderr is insufficient after classification.
- A partially opened event source cannot survive the switch.
- No poll can cover more than the API's one-month limit; normal runtime windows
  are far smaller and pagination is capped.
- The cursor advances only with the page commit. Crash-before-commit repeats;
  crash-after-commit resumes from the stored watermark.
- A cold start does not publish the user's historical library.
- Empty `page_token` is terminal even if present in the response object.
- Owner/participant duplicates, Minutes/VC duplicates, and page overlap yield
  one descriptor per `(kind, artifactId, revision)`.
- Oversized output, malformed JSON, unsafe IDs, impossible timestamps, and
  missing detail fields fail closed without cursor movement.
- Abort interrupts CLI children and cadence waits.

## Red-to-green implementation slices

1. Add failing CLI runner tests for bounded JSON command execution, user-only
   identity, abort, output limits, and typed failure classification.
2. Add failing polling gateway tests for owner/participant pagination,
   Minutes/VC detail normalization, deduplication, bootstrap lookback, cursor
   advancement, no-result cadence, and malformed responses.
3. Implement the read-only CLI runner and polling gateway with injected command
   and clock/sleep seams; keep production defaults package-owned.
4. Add a failing composite-source test proving partial-event cleanup and the
   exact conflict-only switch. Implement the composite startup transition.
5. Update stdio readiness tests so `broker.ready` means either both event
   sources are live or the complete polling source has passed its bootstrap
   probes. All other failures remain terminal diagnostics.
6. Export only the public types needed by the package entrypoint, update the
   package documentation/status language, and keep the universal-bus non-goal
   explicit.

## Verification and delivery

Run in the isolated implementation worktree:

```sh
pnpm --filter @clowder-ai/feishu-meeting-intake test
pnpm --filter @clowder-ai/feishu-meeting-intake typecheck
pnpm --filter @clowder-ai/feishu-meeting-intake lint
pnpm --filter @clowder-ai/feishu-meeting-intake build
pnpm test
pnpm typecheck
pnpm build
```

Then obtain one non-author exact-HEAD review, merge through the repository PR
path, install the resulting displayed official release in Cat Café alpha, and
perform the real meeting dogfood beside the native WebSocket. A green synthetic
test is not a substitute for the final remote observation.
