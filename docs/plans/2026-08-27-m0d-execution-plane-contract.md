---
feature_ids: [P-1, P-1a.0, M0-D]
topics: [plugin-contract, conformance, execution-plane, json-rpc, joint-acceptance]
doc_kind: plan
created: 2026-08-27
---

# M0-D Execution-Plane Contract Plan

## Authority and observed gap

The canonical 18-case behavior fixture at
`@clowder-ai/plugin-contract@0.1.0-beta.11` signs abstract setup, operation,
and behavior verdicts, but it does not say which runtime surface owns each
operation. Joint acceptance in Core PR #1396 therefore had to maintain a
private operation-to-method map and infer a 9 domain / 3 wire-admission / 6
absent split. That consumer-local classification is a second contract truth
source and cannot honestly distinguish Host-to-plugin delivery from Host
control.

The source fixture and public messaging registry are authoritative. The
merged Core evidence at
`clowder-ai@1d56abb75a5bceb9a60eaca4b5a101f50ccf2608` is the consumer
observation that exposed the missing metadata; it does not own the fix.

## Finish line

Publish a merge-ready `@clowder-ai/plugin-contract@0.1.0-beta.12` and its
exact SDK consumer `@clowder-ai/plugin-sdk@0.1.0-beta.8`. Every behavior case
must carry one schema-validated execution plane, exact public method when a
wire surface exists, and a verdict oracle. Core can then classify the fixture
without a private operation catalog or input mutation.

The signed protocol version remains `0.1.0`. Maintainer merge authorizes the
existing automated prerelease workflow; this branch does not publish, promote
`latest`, activate production runtime, or self-merge.

## Machine-readable matrix

| Plane | Count | Method ownership | Verdict oracle |
| --- | ---: | --- | --- |
| `plugin-to-host-wire` | 9 | exact method from the public registry | canonical `expect` |
| `wire-admission` | 3 | exact plugin-to-Host method | JSON-RPC `-32602`; side effects from canonical `expect` |
| `host-to-plugin-delivery` | 1 | exact `host.messaging.deliver` method | canonical `expect` |
| `host-control` | 5 | no wire method may be declared | canonical `expect` |

The three admission cases are raw thread ID send, system audience send, and
snapshot without `maxItems`. Origin forgery is wire-valid and remains a Host
domain verdict. The delivery case is not relabeled Host control merely because
its abstract fixture input is not a raw `M0CDeliverInput` vector.

## Scope fence

In scope:

- Add a required discriminated `execution` contract to the existing fixture
  schema and regenerate public `BehaviorExecution` types.
- Make the fixture sign the exact 9/3/1/5 partition and direction-compatible
  method names.
- Prove admission inputs fail the existing public row validator and domain
  inputs pass it; prove malformed cross-plane methods/oracles fail schema
  validation.
- Advance package metadata, seam metadata, lockfile, and fresh-consumer
  assertions to beta.12/beta.8.

Out of scope:

- Relaxing `MessageDraft`, filling missing snapshot fields, or rewriting any
  canonical case input.
- Inventing plugin wire methods for presets, grant revocation, permission
  policy, or replay-buffer deletion.
- Mapping JSON-RPC admission errors to domain `MessagingErrorCode` values.
- Implementing Host control/delivery behavior in this repository or claiming
  the beta.11 Core run proved those planes.

## Architecture ownership

- **Architecture cell:** contract conformance / canonical behavior fixture.
- **Map delta:** none.
- **Why:** this change adds execution metadata to the existing contract-owned
  schema and fixture. It creates no Store, Queue, Router, Adapter, Dispatcher,
  Binding, or runtime state owner; Core and loopback remain consumers.

## Acceptance evidence

The change starts with focused RED tests for the missing execution type,
required field, package version, and generated projection. GREEN requires:

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

After cross-individual review and maintainer merge, Core pins the exact
published beta.12 fixture export
`@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants`
and removes its private `OPERATION_METHODS` classification table. Joint
acceptance must report each plane separately; a 9/3/1/5 categorized run is
boundary evidence, not 18 canonical runtime passes.
