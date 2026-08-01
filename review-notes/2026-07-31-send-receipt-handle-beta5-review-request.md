---
topics: [plugin-contract, messaging, k1]
doc_kind: review-request
created: 2026-07-31
---

# Review Request: Publish optional `SendReceipt.handle` in contract beta.5

Review-Target-ID: send-receipt-handle-beta5
Branch: feat/send-receipt-handle-beta5
Code SHA: `a08f0127edfe4f014139b03b069fd5e25dadeaa4`

## What

Publishes `SendReceipt.handle?: MessageHandle` in
`@clowder-ai/plugin-contract@0.1.0-beta.5`, regenerates the public type, and
records the prerequisite that the field must exist before or with any future
closure of row 3 (`messaging.send`).

`messaging.send` remains `RESERVED` and `ready: false`. A response shaped like
a receipt with a handle still receives the SDK's T-H/close fail-closed result.

## Why

K-1 needs the public receipt handle shape released and pinned before its next
step. Publishing that schema must not be mistaken for making the reserved row
executable.

## Original Requirements

> Add `SendReceipt.handle?: MessageHandle` as a standalone contract micro-PR
> before K-1 S2. Keep row 3 RESERVED and make its response fail closed.
> `SendReceipt.handle` must exist before or with row-3 closure; never close the
> row first. The PR must state that schema additive is not row-3 closure or
> K-1 execution semantics.

- Source: Fable/Terra gate agreement, thread `thread_mrkmxgdfqquounc9`,
  anchor `0001785457788891-000435-1288a512` (acknowledged by Fable at
  `0001785457789198-000441-c82c06ad`).
- Please verify the diff keeps the four quoted gates, including the deliberately
  narrow compatibility claim: older strict validators can reject the new field;
  version pinning is the cross-version boundary.

## Tradeoff

The registry gains a small machine-checkable temporal-prerequisite field rather
than a comment alone. This adds metadata to the source of wire truth, but makes
the closure ordering regression-testable. It intentionally does not add a
`messaging.send` result schema or execution behavior.

## Architecture Ownership

Architecture cell: plugin contract schema and wire registry
Map delta: none
Why: the existing contract ownership boundary receives one additive receipt
field and one lifecycle constraint; no Store, Queue, Router, Adapter,
Dispatcher, Binding, or host execution path is introduced.

Please check that the diff matches this `Map delta`, and that no implicit
row-3 closure or execution semantics cross the boundary.

## Open Questions

### Technical OQ

1. Does the `schemaClosurePrerequisites` representation unambiguously require
   `SendReceipt.handle` before or with, never after, row-3 closure?
2. Do the schema regression and SDK T-H regression prove the intended separate
   facts without falsely claiming broad old-validator compatibility?
3. Does any changed public surface accidentally enable a success response for
   reserved `messaging.send`?

### Value OQ

None.

## Next Action

Please perform an independent review of `origin/main...a08f0127edfe4f014139b03b069fd5e25dadeaa4`.
Use a GitHub issue comment for your verdict, covering the exact SHA. Do not
merge or treat merge as proof of npm publication.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/send-receipt-handle-beta5/sol`
- Start command: `pnpm test` (library-only; no dev server)
- Ports: web=N/A, api=N/A

### Sandbox Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm conformance
```

## Quality-Gate Evidence

| Check | Result |
| --- | --- |
| Scope | Complete standalone contract micro-PR; no host/K-1 execution change |
| Schema | Valid handle accepted; empty token and extra members rejected |
| Reservation | Row 3 asserted `RESERVED`/not ready; handle-shaped response remains T-H/close |
| Generated surface | `SendReceipt.handle?: MessageHandle`; `generate:check` passed |
| Dogfood | Exempt: contract-only, no user/cat-visible runtime path |
| UI/Pen | Exempt: no UI change; no matching design file |
| Artifact hygiene | Worktree and committed root-media scans empty |

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm conformance
pnpm --filter @clowder-ai/plugin-contract generate:check
git diff --check
# all passed; contract 267/267, SDK 150/150,
# conformance 25/25 fixtures and 18/18 behavior cases
```

## Related Material

- Pull request: https://github.com/zts212653/clowder-ai-plugins/pull/14
- K-1 continuation is blocked until npm exposes the exact beta.5 version and
  integrity. Publication, not PR merge, triggers its next step.
