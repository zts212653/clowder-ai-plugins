---
feature_ids: [P-1, P-1a.0, M0-B]
topics: [plugin-contract, lifecycle, json-rpc, byte-proof, conformance]
doc_kind: plan
created: 2026-08-13
---

# M0-B Lifecycle Ready-Row Closure Plan

## Authority, baseline, and finish line

**Baseline:** `clowder-ai-plugins/origin/main@81ce38c6c7d111ecdd628a9c2446d246dbf49d5f`
(merged PR #31), with `@clowder-ai/plugin-contract@0.1.0-beta.9`,
`@clowder-ai/plugin-sdk@0.1.0-beta.5`, and
`@clowder-ai/feishu-meeting-intake@0.1.0-alpha.2`.

**Authority:** the merged
[`v0-implementation-roadmap.md`](../proposals/v0-implementation-roadmap.md)
defines M0-B as the next public contract slice. The row grammars and SDK
runtime behavior already exist; this slice closes their publication evidence.

**Finish line:** deliver a merge-ready `0.1.0-beta.10` contract candidate and
`@clowder-ai/plugin-sdk@0.1.0-beta.6` consumer in which exactly rows 10–12 are
newly `ready: true`, with public derived byte bounds and executable conformance
vectors consumed by both the SDK and the standalone loopback fixture. A
maintainer merge to `main` authorizes publication: the existing Contract CI
push workflow validates the merged tree and publishes either absent immutable
prerelease under the `next` tag. Publication is not Host activation or M0
acceptance.

## Scope fence

In scope:

- Derive and export compact UTF-8 request/result/error maxima for
  `host.grants.changed`, `host.lifecycle.ping`, and `host.lifecycle.drain`.
- Record those maxima in `WIRE_METHOD_REGISTRY` and advance exactly rows
  10–12 to literal `ready: true`.
- Publish an M0-B lifecycle safety-vector ID set from the existing disposition
  fixture catalog, adding only missing maximum/N+1 or exact lifecycle-result
  vectors required to make the set executable and reviewable.
- Make the contract, SDK classifier, standalone shell, and loopback fixture
  consume the same public vector truth.
- Bump the contract candidate from beta.9 to beta.10 and the SDK from beta.5
  to beta.6, pinning the latter to beta.10. No registry publication occurs in
  this branch; maintainer merge authorizes the existing `main` push workflow
  to publish and verify both currently absent immutable prereleases.
- Treat maintainer approval and merge as the irreversible publication gate;
  there is no second approval boundary between merge and `npm publish`.

Out of scope:

- Host Broker changes, external-process composition, runtime activation,
  manual publication outside the existing workflow, `latest` promotion,
  release-workflow redesign, or consumer re-pin.
- Any messaging row (3–9), its RESERVED leaves, or K-1 ledger/cursor behavior.
- A new lifecycle state machine, a second validator, or a Host-local fixture
  matrix. Existing SDK/standalone enforcement remains authoritative.
- Claiming M0 completion. M0-D still requires real Host/plugin co-run evidence.

## Truth-source matrix

| Concern | Authoritative producer | Consumers that must agree |
| --- | --- | --- |
| Lifecycle wire grammar | `wire/row-shapes.ts` plus `wire/grants.ts` and WireUInt53/RequestId constants | `wire-dispatch.ts`, `standalone-host.ts`, byte-bound construction |
| Encoded maxima | new `wire/lifecycle-byte-bounds.ts`, derived from the closed grammar | registry metadata, public barrel, byte-bound tests |
| Ready partition | `wire/registry.ts` | type tests, runtime method lookup, published package |
| Disposition oracle | `wire/disposition-fixtures.ts` | contract fixture tests, SDK classifier tests, loopback child-process matrix |
| Runtime behavior | SDK `wire-dispatch.ts` and `standalone-host.ts` | focused SDK tests and executable fixture sweep |
| Release candidate | `packages/plugin-contract/package.json` | release-config assertion and packed public boundary |

No consumer may retype lifecycle shapes, hand-enter registry byte counts, or
copy the lifecycle vector membership into an independent matrix.

## Frozen lifecycle invariants

1. `host.grants.changed` is the only notification row. It never produces a
   response. Its input is one closed `GrantSnapshot`; revision is WireUInt53,
   grants are unique members of `VALID_CAPABILITIES`, and cardinality is
   bounded by `MAX_GRANT_ITEMS`.
2. `host.lifecycle.ping` is a request whose `nonce` is 1..512 Unicode code
   points. Its successful result must contain the byte-identical nonce.
3. `host.lifecycle.drain` is a request whose input deadline is a positive
   WireUInt53. Success is exactly `null`; deadline failure is the closed
   `DEADLINE_EXPIRED` error arm.
4. Wrong direction, wrong envelope kind, unknown/extra keys, wrong types,
   empty/N+1 values, invalid integers, invalid grant sets, invalid result
   correlation, and over-frame input fail closed before side effects.
5. The request/result/error maxima cover the full compact JSON-RPC envelope,
   including maximum RequestId and metadata. Error maxima cover every standard
   error allowed for a request row; drain additionally covers
   `DEADLINE_EXPIRED`. The notification row has neither result nor error.
6. `READY_ROWS` becomes exactly rows 1, 2, 10, 11, 12, and 13. Every messaging
   row remains literal `ready: false`, even when its leaf shape is CLOSED.

## TDD implementation plan

### Step 1 — make the expected public partition fail

Update these tests first:

- `packages/plugin-contract/src/wire/wire.test.ts`
  - expect rows 10–12 in `READY_ROWS`;
  - require derived request/result/error metadata where applicable;
  - keep rows 3–9 unready and without publishable bound metadata.
- `packages/plugin-contract/src/wire/wire.type-test.ts`
  - require literal `true` for rows 10–12;
  - retain literal `false` for representative messaging rows.
- `packages/plugin-contract/src/wire/lifecycle-byte-bounds.test.ts`
  - require exact maximum and N+1 proofs for ASCII, multibyte, and escaping
    nonce families;
  - prove grant cardinality, positive drain deadline, request-id N+1, standard
    error arms, and `DEADLINE_EXPIRED`;
  - prove all published maxima are below `MAX_FRAME_BYTES`.
- `packages/plugin-contract/src/wire/disposition-fixtures.test.ts`
  - require a unique exported lifecycle vector set whose members cover all
    three rows and are zero-side-effect before runtime settlement.
- `packages/plugin-contract/scripts/conformance-public-boundary.test.mjs`
  - require lifecycle bounds and vector IDs from the packed artifact.

Run the focused contract tests and record the RED caused by missing exports,
old readiness literals, and missing lifecycle bound evidence.

### Step 2 — derive public lifecycle byte bounds

Add `packages/plugin-contract/src/wire/lifecycle-byte-bounds.ts`:

- construct maximum legal request/result/error frames directly from public
  row constants and `VALID_CAPABILITIES`;
- construct N+1 witnesses without hand-entering protocol limits;
- measure compact `JSON.stringify` output using `Buffer.byteLength(..., 'utf8')`;
- export proof cases and `LIFECYCLE_ROW_ENCODED_BYTE_BOUNDS`;
- expose no generic frame constructor as public protocol API.

Reuse the byte-proof kernel only as independent test evidence. Production
registry metadata must come from the public lifecycle module, while tests
recompute it through `byte-proof/row-proofs.ts` and assert equality.

### Step 3 — advance only rows 10–12

Update `packages/plugin-contract/src/wire/registry.ts`:

- include rows 10–12 in the literal `ReadyRegistryRow` partition;
- spread the corresponding derived bounds;
- describe beta.10 readiness without changing row order, direction, grant,
  notification, settlement, or RESERVED metadata.

Update `packages/plugin-contract/src/wire/index.ts` to export lifecycle proof
metadata and types. Keep generic envelope constructors private.

### Step 4 — publish one executable lifecycle safety set

In `packages/plugin-contract/src/wire/disposition-fixtures.ts`:

- export `BETA10_LIFECYCLE_VECTOR_IDS` as IDs from the canonical fixture list;
- add the minimum missing vectors needed for legal maximum and rejected N+1
  lifecycle inputs, exact ping correlation, drain null/deadline behavior, and
  grants notification semantics;
- mark pre-dispatch safety cases `zeroSideEffects: true`;
- do not invent Host persistence observations or activation fixtures.

Re-export the set through both `wire/index.ts` and `conformance/index.ts`.
Make SDK and loopback tests iterate that same set where their execution layer
can represent the fixture pre-state; explicitly register correlation seams
that a child process cannot inject.

### Step 5 — lock release and compatibility evidence

- Bump `packages/plugin-contract/package.json` to `0.1.0-beta.10` and
  `packages/plugin-sdk/package.json` to `0.1.0-beta.6`, with the SDK pinned to
  the exact beta.10 contract. The Feishu alpha.2 package remains unchanged and
  continues to declare the versions against which its immutable tarball was
  published.
- Update `conformance/release-config.test.ts` to lock the package candidate.
- Re-run generated-output checks; do not regenerate unrelated schema output.
- Prove existing SDK lifecycle behavior remains green without new Host code.

## Required acceptance evidence

Run in this feature worktree:

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

Acceptance requires:

- observed RED before the production change and GREEN at the final exact SHA;
- registry, derived byte proofs, public exports, fixture membership, SDK
  classification, and packed artifact all agree;
- no Host activation or messaging-row readiness appears in the diff;
- a cross-individual formal review approves the exact final SHA; an optional
  fresh-context pre-scan may generate findings but is not approval authority;
- CI and maintainer review pass before merge; maintainer merge is explicit
  authorization for the automated immutable beta.10/beta.6 publication, and
  the author performs neither self-merge nor manual publication;
- after merge, the same `main` push workflow must publish or verify the exact
  versions and integrities while preserving `latest`; successful registry
  verification remains a downstream acceptance predicate before Host support
  may advertise or emit these rows, not a second publication-approval gate.
