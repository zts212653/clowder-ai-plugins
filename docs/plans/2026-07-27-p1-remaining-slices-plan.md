---
feature_ids: [P-1]
topics: [sdk, wire-dispatch, standalone-io, slice-plan]
doc_kind: plan
created: 2026-07-27
---

# P-1 Remaining Slices Plan (M0 PR-4 Completion)

**Baseline**: `main@ae9dc86` (PR #12 merged) + `feat/p1-sdk-dispatch`
**Truth source**: `docs/proposals/v0-implementation-roadmap.md` PR-4 + M0 gate
**Contract surface**: beta.4 frozen wire shapes (12 rows, all `ready: false`)

## Slice DAG

```
S1 dispatch → S2 shell → S3 handshake → S4 loopback plugin → S5 adversarial matrix (SDK half)
                                                                  ↓ (blocked seam)
K-1/K-2 merged (maintainer) ───────────→ host half co-run + M0 gate acceptance
```

| Slice | Content | Package boundary | RED input |
|---|---|---|---|
| **S1** wire dispatch | Classify decoded frames per frozen disposition table T-C..T-L; method gate; direction gate; RESERVED→T-G; CLOSED-row input validation; cross-frame oracle | `plugin-sdk/src/wire-dispatch.ts` + test | Contract disposition-fixtures (test-only relative import) |
| **S2** shell completion | Manifest load+validate → fail-closed startup; `startStdioRuntime` ← S1 dispatch; `ping/drain` plugin-side response logic | `plugin-sdk/src/standalone-host.ts` (new) or runtime extension | Illegal/unauthorized manifest fixtures |
| **S3** handshake client | CandidateHello construction (digest/nonce); SessionBinding validation; zero production frames before `broker.ready` | `plugin-sdk/src/handshake-client.ts` + PassThrough fake host test | Bad digest / illegal binding / out-of-order ready |
| **S4** loopback fixture plugin | Independent private workspace package; legal manifest + stdio startup + schema-neutral echo | `packages/loopback-fixture-plugin/` (`private: true`) | End-to-end: spawn real child process |
| **S5** adversarial matrix SDK half | Framing/envelope/method-gate/handshake/lifecycle/oversize violations; fixture-driven for host CI reuse | `plugin-sdk` or conformance directory | Contract fixtures + S4 |

## Non-claims (every PR body)

1. 12 rows remain `ready: false` — no flip, no flip request
2. No host Broker/Adapter implementation (K-2 = maintainer)
3. No M0 gate claim (precondition: K-1/K-2 merged)
4. No new wire shapes beyond beta.4
5. Loopback echo ≠ `messaging.send` production semantics
6. No changes to clowder-ai core worktree

## Rulings (Fable, 2026-07-27)

### F1: beta.4 artifact immutability

S1 must not modify the published contract barrel (`wire/index.ts`).
Disposition fixtures are consumed via **test-only relative import**
(`../../plugin-contract/src/wire/disposition-fixtures.js`) — test files
are excluded from the SDK dist artifact, no P14 violation.

**Delta carry-forward items** (next contract revision, not standalone):
- (a) Promote disposition fixtures to public conformance export
- (b) Add reserved-method fixture vectors to the disposition fixture set

### F2: RESERVED method ready gate belongs to S1

Contract evidence chain:
1. Disposition table is frozen; ACCEPT_CLASSES = {T-J, T-L} only — no
   accept class exists for Requests
2. RESERVED rows have input type `never` — no legal params value exists
3. Therefore: any RESERVED-method Request → T-G (value violation,
   respond error, id echoed)

S2 handler shell may keep a defensive assertion but is not the primary gate.

### F3: Contract-mirror drift prevention (R3 seam ruling)

When the contract expresses a closed constraint only at the type level
(additionalProperties: false, enum unions) with no runtime export,
the SDK may create a **mirror constant** under these rules:

1. **Centralized**: all mirrors live in `contract-mirror.ts` (self-documenting
   name: "this is a deletable mirror")
2. **Drift-tested**: each mirror has a test in `contract-mirror.test.ts`
   anchored to the contract source (schema JSON enum where available,
   structural assertions against contract types elsewhere). Drift = CI red.
3. **Delta-listed**: all mirrors are scheduled for deletion in the beta.5
   delta scope when the contract exports runtime equivalents.

Pattern precedent: #10 MAX_FRAME_BYTES alias + drift test → F1 fixtures
test-only import → F3 systematic contract-mirror.

**beta.5 delta scope** (accumulated):
- (a) from F1: Promote disposition fixtures to public conformance export
- (b) from F1: Add reserved-method fixture vectors
- (c) from F3: codegen "schema enum → runtime const array" for MessagingErrorCode
- (d) from F3: Delete `contract-mirror.ts` — replace with public contract imports

### Consumption path (F1/F3 method — applies to S1 and future slices)

SDK production code imports from `@clowder-ai/plugin-contract` public
barrel and `./contract-mirror.js` (for type-level-only constraints).
Test files may use relative imports to contract source when the needed
symbol is not part of the published surface. Typecheck uses
`tsconfig.build.json` (production code) + `tsconfig.test.json` (test
files, separate due to rootDir constraint from cross-package relative
imports). Both are run by `pnpm typecheck`.

## Branch / Gate / Handoff

- **Branch**: `feat/p1-sdk-dispatch` from main; single clean commit per slice
- **Gate (per slice)**: TDD → `pnpm --filter @clowder-ai/plugin-sdk test` +
  monorepo typecheck/lint/build/conformance all green → quality-gate →
  cross-individual review (sol/kimi) → PR + `register_pr_tracking` →
  codex → maintainer
- **Shape gap / contract contradiction**: stop → `@Fable` for delta
  co-sign, no workaround
