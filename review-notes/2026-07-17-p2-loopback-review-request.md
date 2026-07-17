# Review Request: Execute P-2 messaging conformance in loopback

Review-Target-ID: `m0-standalone-loopback`
Branch: `feat/m0-standalone-loopback`

## What

- Generate the behavior-fixture TypeScript projection from its JSON Schema.
- Execute every committed behavior case through a reusable evaluator and deterministic reference adapter.
- Make the repository runner fail closed for malformed, unsupported, thrown, mismatched, or empty conformance runs.
- Publish the reusable boundary as `@clowder-ai/plugin-contract/conformance`.
- Prepare the unique `0.1.0-beta.2` artifact with Node 24 and npm Trusted Publishing while preserving the pre-publish `latest` target.

## Why

Schema-valid fixture data is not executable conformance. Host and SDK consumers need one machine-readable oracle, one assertion evaluator, and one reference-host interpretation before either side can claim the signed messaging slice is implemented.

## Original Requirements

> P15: schema, types, capability table, and conformance fixtures ship in one contract package; Host and SDK consume rather than copy them.
> M0 starts with a contract conformance fixture plus loopback that verifies grants, messaging operations, ack/ledger, and adversarial fail-closed cases.
> GitHub alone cannot validate standard M0 I/O; a minimum loopback/standalone vertical slice must exist first.

- Source: `docs/proposals/plugin-system-principles-and-v0-design.md` (P15; M0 sections)
- Delivery plan: `docs/plans/2026-07-16-p2-loopback-executor.md`
- Please judge the delivery against this excerpt, including its explicit non-claim of complete Host Broker or cross-process standalone I/O.

## Tradeoff

The adapter is deterministic and in-memory. It deliberately omits handshake, JSON-RPC/stdio framing, process supervision, durable Host state, and the later positive event-production/read/ack expansion. Those belong to subsequent M0 slices. In exchange, P-2 stays independently testable and does not invent production transport semantics.

## Architecture Ownership

Architecture cell: `plugin-contract / conformance` (existing P15 machine-truth boundary)
Map delta: none
Why: the new `MessagingLoopbackAdapter` is a reference conformance adapter inside the existing contract package; it does not become the production Host Adapter, Store, Queue, Router, or Broker.

Please verify that the diff matches `Map delta: none`, especially that no parallel production state owner or transport binding was introduced.

## Invariant Matrix

| Invariant | Assertion | Verification |
|---|---|---|
| INV-1 Schema ownership | Behavior operations, verdicts, targets, capabilities, and error codes project from schema-owned definitions | codegen freshness + drift mutation tests |
| INV-2 Execute once | Each case captures asserted targets before/after and executes its operation exactly once | `behavior-executor.test.ts` |
| INV-3 Zero mutation on denial | Permission, validation, conflict, and ownership failures preserve every asserted collection | 18 distributed behavior cases + adapter sibling tests |
| INV-4 Canonical handle scope | Every handle-consuming transition requires kind, owner, and non-empty canonical thread; message/envelope scope must match before mutation | unresolved send/subscribe, cross-thread append, and mismatched callback regressions |
| INV-4A Distinct callback authority | `onMessage` callback delivery requires `onMessage`; event subscription operations independently require `message.event.subscribe` | grant inversion regression + denied distributed callback oracle |
| INV-4B Preset policy | First-party preset application accepts exactly generated L1 and rejects every generated L0/L2 capability before mutation | full generated capability-layer regression |
| INV-4C Subscription authority | Existing subscription operations require `message.event.subscribe` and caller ownership; ack tokens and replay deletion are subscription-local | missing-grant and foreign-caller mutations + two additive behavior oracles + cross-subscription deletion regression |
| INV-5 Runner completeness | Missing fixtures/cases, malformed fixtures, unsupported executors, adapter throws, and oracle mismatches contribute failures | runner integration + empty-tree + mutated observation tests |
| INV-6 Published reachability | Host/SDK can import the executor and loopback adapter without importing the Ajv-backed repository runner | exports-map test + built package self-import |
| INV-7 Release identity | beta.2 moves only `next`, preserves the pre-publish `latest`, and can skip publish only after exact integrity match | workflow mutation suite + `bash -n` + pack inspection |

## E2E User Path Evidence

No frontend/user interaction is changed. Developer-path dogfood passed:

1. `pnpm conformance` executes 25/25 structural fixtures and 18/18 behavior cases.
2. A built package self-reference imports `@clowder-ai/plugin-contract/conformance` and exposes `executeBehaviorCase` plus `MessagingLoopbackAdapter`.
3. `npm pack --json --ignore-scripts` produces beta.2 with schemas, generated types, behavior fixtures, conformance output, and no governance documents.

## Open Questions

### Technical OQ

- Does the reference adapter preserve every authorization and zero-mutation invariant without implying production Broker ownership?
- Is the runner executor registry and 0/0 lower bound fail-closed under all discovered-file paths?
- Does the OIDC rerun path prove exact artifact identity before skipping publish and then recheck `next`/`latest`?

Please verify every Invariant Matrix row.

### Value OQ

None. P-2 remains inside the already selected M0 sequence and does not redirect product scope.

## Fresh-Context Findings

Agent: `[宪宪/Fable🐾]`
SHA scanned: `c933d32`; fixes confirmed at exact `e72ae617d3cf1107639c01b4051cae95153f0e70`
Total findings: 5 (0 P1, 2 P2, 3 P3)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 | Subscription grant/owner checks were asymmetric | fixed (`e72ae61`), including additive behavior oracles | ✅ |
| FC-2 | Empty conformance tree returned 0/0 success | fixed (`e72ae61`) | ✅ |
| FC-3 | Documented Host/SDK API was absent from package exports | fixed (`e72ae61`) | ✅ |
| FC-4 | Push-only OIDC path cannot execute in PR CI | retained as independently verified pre-merge Trusted Publisher gate | ✅ |
| FC-5 | Positive event generation/read/ack flow has no oracle | bounded to later C-2/M0 expansion; explicit P-2 non-claim | ✅ |

Formal reviewer: annotate findings with `[FC:covered]`, `[FC:new]`, or `[FC:N/A]`.

## Automated Review R1

Reviewed SHA: `4614fab7a1d0ec81405a1d8f467183949c0ec0a3`

| # | Finding | Delta | Author disposition |
|---|---|---|---|
| R1-1 | The loopback rejected schema-valid `connector_binding` send addresses before ownership validation | `[FC:new]` | fixed with owned-success and foreign-owner rejection regressions |
| R1-2 | Replay deletion authorized one subscription but filtered every low-sequence event | `[FC:new]` | fixed by matching `subscriptionId` before sequence deletion; other and unscoped buffers remain preserved |

The 18-case distributed suite does not grow in this round. Existing case IDs, operations, invariants, and expected verdicts remain unchanged; the replay-deletion seed gains an explicit `subscriptionId` so its retention scope is machine-readable.

## Independent Delta Review R2

Reviewed SHA: `ac5fd39dc10d52c60eabc04adbf19f203bbb9a0a`

| # | Finding | Failure mode | Author disposition |
|---|---|---|---|
| R2-1 | An owned send handle without `threadId` succeeded and materialized a non-canonical message | repeated optional handle-target assumption | fixed with one pre-mutation target-resolution guard shared by both send address variants |

The regression exercises unresolved `thread_handle` and `connector_binding` targets and requires `NOT_FOUND` with zero changes to messages, output events, and the idempotency ledger. R3 later disproved the narrow R2 audit: checking append's `messageId` did not bind its canonical message thread, and subscribe still projected an unscoped subscription.

## Maintainer Exact-Head Review R3

Reviewed SHA: `eff864eeb9ad2cc58b8fbbd127a42ce1fe59c9fd`

| # | Finding | Failure mode | Author disposition |
|---|---|---|---|
| R3-1 | callback delivery used the event-subscription grant and ignored envelope scope | distinct capability and canonical scope were collapsed | fixed by consuming full delivery input, requiring `onMessage`, and matching envelope/handle threads before delivery |
| R3-2 | append could mutate a canonical message from another thread | handle ownership was treated as sufficient authorization | fixed by requiring resolved handle/message scope equality before revision/content checks or mutation |
| R3-3 | first-party presets admitted L0 although the signed matrix permits only L1 | policy implemented as an L2 denylist instead of an L1 allowlist | fixed by deriving the complete allowlist from generated `CAPABILITY_TABLE.L1` and testing every L0/L2 capability |
| R3-4 | range `git diff --check` was red | Markdown hard-break whitespace contradicted the claimed gate | fixed by removing the two trailing-space markers |

Because this was the third review round on the same state object, the implementation plan now contains a stateful-object truth matrix and transition table. The failure-mode sweep also hardened the sibling `subscribe` transition: it rejects unresolved thread scope and persists the resolved canonical thread on the subscription projection. No new distributed case ID or expected verdict was introduced.

## Next Action

Review the exact PR HEAD independently and post a logical APPROVE or REQUEST-CHANGES comment anchored to that SHA. This request is for a formal verdict, not another fresh-context scan.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/m0-standalone-loopback/{reviewer-handle}`
- Start command: `unset NODE_ENV && pnpm install --frozen-lockfile`
- Validation: use the commands below; no services or ports are required.

## Self-check Evidence

### Spec compliance

- P15 remains one package-owned machine truth.
- Initial 16 case IDs, operations, invariants, and expectations are unchanged; 2 additive subscription-authorization oracles are disclosed. The replay-deletion seed now explicitly identifies its subscription after R1.
- P-2 does not claim complete standalone transport, Host Broker, or positive event lifecycle.
- npm `contractVersion` remains `0.1.0`; artifact version is uniquely `0.1.0-beta.2`.

### Test results

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @clowder-ai/plugin-contract generate:check
pnpm typecheck
pnpm lint
pnpm test          # 100/100
pnpm build
pnpm conformance   # 25/25 structural, 18/18 behavior
git diff --check origin/main...HEAD
```

Additional evidence:

- Three workflow `run: |` blocks pass `bash -n`.
- Built package self-import passes.
- Exact pack integrity after R3: `sha512-w3mKikO8v7YwN5ZyLY3twqRgrIcSIxHLitCBu1wpsF41ms8ygvN7Qw20u2haoT36DrZRXvCHgC6kXQPj/7G36Q==`.
- Root artifact gates returned no matches.

## Related Documents

- `docs/proposals/plugin-system-principles-and-v0-design.md`
- `docs/plans/2026-07-16-p2-loopback-executor.md`
