---
feature_ids: [P-1, P-1a.0, M0-C]
topics: [plugin-contract, messaging, json-rpc, idempotency, cursor, conformance]
doc_kind: plan
created: 2026-08-18
---

# M0-C Messaging Ready-Row Closure Plan

## Authority, baseline, and finish line

**Plugin baseline:**
`clowder-ai-plugins/origin/main@5f68ca1e64046d949373aa28e08be74c6789be47`
(merged PR #32), with `@clowder-ai/plugin-contract@0.1.0-beta.10` and
`@clowder-ai/plugin-sdk@0.1.0-beta.6` published under `next`.

**Host baseline inspected:**
`clowder-ai/origin/main@56d7c29321d0f972bb8a6b9601650641449286b6`.
That tree does not yet close every source-admission and stored-data predicate
needed by messaging rows 3–9. In particular, its public validators still use
JavaScript string length and integer checks, and its event-stream surface does
not yet implement the frozen paging and acknowledgement topology. This plan
therefore defines the target contract but does not treat current K-1 as ready
evidence.

**Authority:** `docs/proposals/v0-implementation-roadmap.md`, the canonical
18-case `host-half-seam-manifest.json`, and upstream `clowder-ai#1165` define
M0-C. `clowder-ai-plugins#19` identifies one beta.10 drift: send success must
be `{ messageHandle }`, where `messageHandle` is required and is an existing
closed `MessageHandle`; the optional `{ handle }` shape is removed rather than
retained as a compatibility alias.

**Finish line:** deliver a merge-ready `0.1.0-beta.11` contract candidate and
`@clowder-ai/plugin-sdk@0.1.0-beta.7` consumer in which exactly rows 3–9 are
newly ready. The contract, SDK, standalone shell, and loopback fixture consume
one canonical 18-case matrix. Ready evidence must name the exact Host commit
that supplies the missing source-admission and messaging-state predicates;
the plugin PR may be developed in parallel, but it cannot claim those Host
predicates from the inspected baseline.

## Scope fence

In scope:

- Close and publish the seven frozen messaging row shapes: send, append,
  subscribe, read-page, acknowledge, snapshot-page, and inbound delivery.
- Resolve issue #19 at the source schema and all generated/public consumers by
  making `SendReceipt.messageHandle` required.
- Derive compact UTF-8 request/result/error maxima and executable maximum/N+1
  witnesses for every row; no registry byte count is hand-entered.
- Advance only rows 3–9 to literal `ready: true`, preserving row order,
  direction, grants, and standard error policy.
- Make contract disposition fixtures, SDK classification, standalone I/O, and
  loopback execution reuse the canonical 18-case fixture and its vector IDs.
- Lock beta.11/beta.7 package metadata. Publication remains authorized only by
  maintainer merge and the existing main-push workflow.

Out of scope:

- Reimplementing the K-1 ledger, cursor, entitlement, retry, or dead-letter
  state machines in this repository.
- Claiming the current Host baseline already meets M0-C, manufacturing Host
  evidence in a loopback adapter, or copying the 18 cases into a second matrix.
- Production activation, non-dormant external-process wiring, manual npm
  publication, `latest` promotion, or M0-D acceptance.
- Lifecycle-row or Plugin Control Plane changes.

## Truth-source matrix

| Concern | Authoritative producer | Consumers that must agree |
| --- | --- | --- |
| Wire grammar | `wire/row-shapes.ts` plus the source schemas | registry, SDK dispatch, standalone parser, byte proofs |
| Encoded maxima | one derived messaging byte-bound module | registry metadata, public barrel, packed artifact, proof tests |
| Ready partition | `wire/registry.ts` | type tests, runtime lookup, published package |
| Behavioral cases | canonical 18-case conformance fixture and vector IDs | contract, SDK, standalone loopback, Host joint acceptance |
| Stateful truth | K-1 MessagingDomain at the exact Host acceptance SHA | Host routes and joint M0-D evidence; never plugin-local shadow state |
| Release candidate | contract and SDK package manifests | release-config test, lockfile, fresh-consumer test |

## Frozen public shapes

1. Send accepts `MessageDraft` and returns
   `{ messageHandle: MessageHandle }`. `messageHandle.token` must not equal the
   input `messageId`.
2. Append accepts the frozen thread handle, expected revision, and envelope;
   success echoes the resulting revision/receipt exactly as defined by the
   admitted source shape.
3. Subscribe returns the frozen subscription identity used by later rows.
4. Read-page accepts `{ subscriptionId, limit }`, where the identifier is
   1..128 Unicode scalar values and `limit` is an integer in 1..32. Its closed
   response union has empty, normal, and terminal variants; normal
   acknowledgement tokens are 1..512 scalar values, no page token is exposed,
   and `events.length <= input.limit`.
5. Acknowledge uses the shared
   `{ subscriptionId, ackToken }` request. K-1 resolves whether the token is a
   read acknowledgement or a snapshot-completion acknowledgement.
6. Snapshot-page accepts
   `{ subscriptionId, maxItems, pageToken? }`, where `maxItems` is an integer
   in 1..64 and page tokens are 1..512 scalar values. Intermediate and final
   response variants are closed; final completion is settled only through the
   shared acknowledgement row.
7. Inbound delivery accepts
   `{ deliveryId, threadHandle, envelope }` and succeeds with the byte-identical
   `{ deliveryId }`; the closed delivery-rejection reasons map to the public
   application error taxonomy.
8. Every object is closed, identifiers use Unicode scalar counts, numeric
   domains use safe WireUInt53-style validation, and compact encoded limits
   cover request, success, and all admitted error arms.

## Stateful invariants the Host evidence must prove

### Write and settlement — send and append

- A logical operation moves through absent, claimed, and settled states.
- The same idempotency key plus byte-equal input converges on the same result;
  the same key plus different input conflicts without mutating state.
- Shape, authorization, byte-bound, and correlation checks precede claims or
  writes. Proof failure leaves no claim, message, revision, or settlement.
- Append is revision-CAS guarded; a stale revision cannot create an envelope,
  advance a revision, or consume its idempotency key.

### Subscription and catch-up — subscribe, read, acknowledge, snapshot

- The durable invariant is `acked <= lastDelivered <= head`.
- Empty, normal, and terminal read variants are deterministic. Empty reads,
  stale tokens, and proof failures do not advance either cursor.
- Read acknowledgements may advance `acked` only through an issued entitlement.
- Snapshot pages do not advance live-delivery cursors. The final page issues a
  distinct completion entitlement, and acknowledging it atomically advances
  the admitted cursor pair.
- Replay, cross-kind, cross-subscription, expired, or fabricated tokens fail
  with zero cursor or entitlement mutation.

### Callback delivery — inbound delivery

- Host-owned delivery state moves through queued, leased, retryable,
  dead-letter, and settled states.
- Success echoes `deliveryId` exactly. Rejection reasons map deterministically,
  while retry and dead-letter policy remain Host-owned.
- Identifier mismatch, malformed result, timeout, or protocol failure cannot
  settle the delivery or move lease, attempt, or watermark state incorrectly.

## TDD implementation plan

### Step 1 — make the public target fail

Update contract tests before production code to require:

- literal readiness for rows 3–9 and executable request/result shapes;
- required `SendReceipt.messageHandle`, rejection of missing/legacy `handle`,
  and the non-equality oracle;
- closed read/snapshot response unions and exact scalar/integer boundaries;
- derived request/result/error maxima with ASCII, multibyte, escaping, exact
  maximum, and N+1 witnesses;
- one exported M0-C vector-ID set covering all canonical 18 cases;
- the same public surface from the packed artifact.

Run the focused tests and preserve the RED output showing that beta.10 still
has reserved row shapes, false readiness literals, and the legacy send field.

### Step 2 — close the source grammar

- Change the messaging schema and generated types so send success exposes only
  required `messageHandle`.
- Replace the reserved `never` row shapes with the seven frozen closed shapes,
  reusing existing identifier, envelope, error, and integer primitives.
- Keep response variants discriminated and exhaustively validated; no loose
  record, alias, optional compatibility field, or permissive fallback enters
  the public surface.
- Regenerate checked artifacts and prove generation is deterministic.

### Step 3 — derive byte bounds and advance the registry

- Add a messaging byte-bound module that constructs legal maxima and N+1
  witnesses from public constants and measures compact UTF-8 JSON-RPC frames.
- Independently recompute the maxima in the byte-proof kernel and assert exact
  equality.
- Attach the derived metadata and advance exactly rows 3–9 to ready. Update the
  literal registry partition and compile-time type assertions together.

### Step 4 — execute one canonical 18-case matrix

- Export M0-C vector IDs from the existing conformance fixture catalog; add
  only missing boundary/correlation cases to that catalog.
- Make contract, SDK, standalone-host, and loopback tests select those IDs
  instead of retyping expectations.
- Keep the loopback adapter an execution seam, not a substitute K-1 ledger.
  Stateful settlement/cursor truth is accepted only from the exact Host SHA.
- Update `host-half-seam-manifest.json` with the exact contract expectation,
  while keeping its Host requirement explicit until the joint run exists.

### Step 5 — lock release and joint-acceptance evidence

- Bump the contract to beta.11 and SDK to beta.7, pinning the SDK to the exact
  contract candidate and updating release-config/fresh-consumer assertions.
- Rebase on the current plugin `origin/main` immediately before final review.
- Record the exact parallel Host PR SHA that closes scalar/safe-integer source
  admission, storage attestation, the seven K-1 routes, and dormant standalone
  composition. Joint acceptance must run all 18 cases against those two exact
  SHAs; plugin-local green tests alone do not satisfy this gate.
- Obtain cross-individual review and maintainer approval. Do not self-merge or
  manually publish.

## Required acceptance evidence

Run in the M0-C feature worktree:

```sh
pnpm --filter @clowder-ai/plugin-contract generate:check
pnpm --filter @clowder-ai/plugin-contract typecheck
pnpm --filter @clowder-ai/plugin-contract test
pnpm --filter @clowder-ai/plugin-contract conformance
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/plugin-sdk typecheck
pnpm --filter @clowder-ai/plugin-sdk test
pnpm --filter @clowder-ai/loopback-fixture-plugin lint
pnpm --filter @clowder-ai/loopback-fixture-plugin test
pnpm test:fresh-consumer
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm conformance
git diff --check
```

Acceptance requires an observed RED before implementation, GREEN at the exact
candidate SHA, exact agreement among registry/proofs/public exports/fixture
selection/SDK/packed artifact, and the joint Host evidence above. Maintainer
merge authorizes only the existing automated immutable beta.11/beta.7
publication under `next`; `latest`, production activation, and M0-D remain
separate gates.
