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
| INV-4 Subscription authority | Existing subscription operations require `message.event.subscribe` and caller ownership; ack tokens and replay deletion are subscription-local | missing-grant and foreign-caller mutations + two additive behavior oracles + cross-subscription deletion regression |
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
pnpm test          # 95/95
pnpm build
pnpm conformance   # 25/25 structural, 18/18 behavior
git diff --check origin/main...HEAD
```

Additional evidence:

- Three workflow `run: |` blocks pass `bash -n`.
- Built package self-import passes.
- Exact pack integrity after R1: `sha512-qQo4mk5UFCURsAWKww7iHc34oylVLpRjqwRJYSYIYxKCbo01B0AsmZcRSLMTtyIeyxhUtZN56hSCCThV21+v/A==`.
- Root artifact gates returned no matches.

## Related Documents

- `docs/proposals/plugin-system-principles-and-v0-design.md`
- `docs/plans/2026-07-16-p2-loopback-executor.md`
