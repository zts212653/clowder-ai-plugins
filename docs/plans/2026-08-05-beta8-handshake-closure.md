---
feature_ids: [P-1, P-1a.0, K-2B]
topics: [plugin-contract, json-rpc, handshake, byte-proof]
doc_kind: plan
created: 2026-08-05
---

# beta.8 Handshake Contract Closure Plan

## Authority, baseline, and outcome

**Baseline:** `clowder-ai-plugins/main@bf94133` with
`@clowder-ai/plugin-contract@0.1.0-beta.7`.

**Authorization:** maintainer comment
[`#1165#issuecomment-5187378483`](https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5187378483)
authorizes one first closure slice: only row 1 `broker.hello` and row 2
`broker.ready` advance to `ready: true`. Its exact-HEAD review is the
next external gate.

**Outcome:** publish a review-ready PR for
`@clowder-ai/plugin-contract@0.1.0-beta.8` that owns the complete,
bounded handshake wire shape. It is a contract and conformance change;
it does not implement or activate the Host Broker.

## Scope fence

In scope:

- Close H1/H3/H4/H5/H6 and make their validators public contract exports.
- Turn rows 1 and 2 from stubs into executable request/result shapes.
- Derive, export, and registry-record `maxEncodedRequestBytes`,
  `maxEncodedResultBytes`, and `maxEncodedErrorBytes` for both rows.
- Add raw UTF-8 byte proofs and conformance vectors for the maximum and
  rejected N+1 values in ASCII, multibyte, and JSON-escaping families.
- Advance exactly rows 1 and 2 to `ready: true`; all other rows remain
  literal `ready: false`.
- Extend the disposition table with `T-M`: a legal Request for a ready row
  is accepted for dispatch. Existing `T-A` through `T-L` are unchanged.
- Make the minimum SDK classifier and standalone-shell changes needed to
  consume that revised contract without accidentally implementing handshake
  codec behavior.

Out of scope:

- SDK handshake-client codec/state-machine wiring, Host Broker, callback
  delivery, dead-letter/reconcile behavior, runtime activation, or consumer
  re-pin. The SDK classifier and shell's passive compatibility adaptation are
  intentionally in scope so this workspace stays coherent.
- Rows 3–12, including the pending `SendReceipt` handle delta and the
  deferred public fixtures/codegen carry-forward items.
- A core-local copy of any wire structure. Consumers must use this
  published contract only after the later integrity/digest gate.

## Proposed closed wire grammar

The values below are a beta.8 proposal for Fable review, not a claim about
the inaccessible K-2A implementation. The maintainer explicitly assigned
these wire grammars to the contract PR; Host minting and lifecycle semantics
remain Host-owned.

| Entry | Wire grammar and validator | Rationale / source relation |
| --- | --- | --- |
| **H1 `pluginId`** | JavaScript string with **1..256 Unicode code points**, measured using the existing H9 `[...value].length` convention. No further lexical restriction. Worst compact JSON string: `1,538` bytes. | Manifest schema currently permits any non-empty string with no upper bound. beta.8 does not tighten manifest admission; it adds the finite wire-send boundary. A manifest value above 256 cannot form a conformant `broker.hello`. |
| **H3 `contractVersion`** | Exact SemVer 2.0.0 string matching the existing manifest `$defs.SemVer` regular expression, **1..256 ASCII code points**, no range/wildcard/operator. Worst compact JSON string: `258` bytes. | Reuses the manifest's exact-published-version semantics and makes its previously unbounded representation measurable. |
| **H4 `wireVersion`** | Exact SemVer 2.0.0 string under the same closed `1..256` ASCII grammar as H3. The candidate is a wire compatibility claim; the Host's supported-version decision is not encoded as a new field. | Reuses the proven SemVer validator rather than introducing a second version language. |
| **H5 `pluginInstanceId`** | Opaque Host-minted string, **1..512 Unicode code points**, with no caller-selected lexical semantics. Worst compact JSON string: `3,074` bytes. | Same bounded opaque-string pattern as closed H9 `bindingNonce`; Host remains free to choose its durable installation identity format. |
| **H6 `brokerSessionId`** | Opaque Host-minted string, **1..512 Unicode code points**, with no caller-selected lexical semantics. Worst compact JSON string: `3,074` bytes. | Same H9 pattern; the Host retains per-connection/session lifecycle semantics. |

`packageDigest` (H2), `grantRevision` (H7), `effectiveGrants` (H8), and
`bindingNonce` (H9) keep their already-closed beta.7 definitions.

### Closed objects and authority boundary

All object validators reject additional properties.

```text
broker.hello request input  = CandidateHello
  { pluginId, packageDigest, contractVersion, wireVersion }

broker.hello success result = SessionBinding
  { pluginId, packageDigest, contractVersion, wireVersion,
    pluginInstanceId, brokerSessionId, grantRevision,
    effectiveGrants, bindingNonce }

broker.ready request input  = BrokerReadyParams
  { bindingNonce }

broker.ready success result = null
```

`broker.ready` is activation-only, not resume. Caller-provided
`pluginInstanceId`, `brokerSessionId`, `grantRevision`, or grants on either
handshake request are a `HANDSHAKE_REJECTED` /
`AUTHORITY_VIOLATION` before dispatch. `SessionBinding` is Host-authoritative:
it contains the Host-minted H5/H6 values and does not allow the plugin to
write them back. A reconnect performs a new hello/ready exchange; this PR
does not introduce a resume token.

## Mechanical implementation plan

1. **Close the handshake module.** In `wire/handshake.ts`, introduce the
   H1/H3/H4/H5/H6 constants, exact validators, encoded-byte constants, and
   closed-object validators for `CandidateHello`, `SessionBinding`, and
   `BrokerReadyParams`. Factor the code-point check used by H1/H5/H6 so
   H9 keeps identical semantics rather than forked validation logic.
2. **Promote only the two row shapes.** Replace `HelloInput`/`HelloResult`
   with `CandidateHello`/`SessionBinding`, and `ReadyInput`/`ReadyResult`
   with `BrokerReadyParams`/`null`. Change registry typing so rows 1–2 are
   statically `true` while rows 3–12 retain literal `false`; update the
   derived ready/reserved row assertions without loosening their count.
3. **Add the ready-Request disposition.** Add `T-M` with outcome `accept`,
   `dispatches: true`, and no error response: a closed, legal Request for a
   registry row marked `ready: true` reaches its method handler. This is the
   contract-revision consequence of rows 1–2 no longer being `never`; it does
   not alter T-A through T-L or make any reserved row legal.
4. **Make byte bounds one-source-derived.** Add handshake request, result,
   and error templates to the existing byte-proof machinery. Compute each
   maximum from those templates, export the computed metadata, and have the
   registry consume that same metadata. There must be no independently
   hand-entered byte number or barrel-import cycle. Each proof covers the
   compact UTF-8 JSON-RPC envelope, request id, call metadata, all H fields,
   closed handshake reject reasons, and the full error envelope.
5. **Publish conformance data, not a Host implementation.** Add valid and
   invalid handshake fixtures that identify the expected pre-dispatch
   disposition and `zeroSideEffects: true`. The contract tests prove the
   validator/proof/fixture agreement; K-2B Host acceptance later proves
   actual ledger and write-queue non-mutation using these exported vectors.
6. **Adapt the SDK only at the contract boundary.** Teach
   `wire-dispatch.ts` to validate the two ready handshake inputs and return
   `T-M` for valid inputs. The standalone shell then returns its conservative
   standard method error because it deliberately has no Broker/codec yet;
   tests pin that temporary behavior. It must not construct a hello/ready
   request, persist state, send an activation frame, or claim that K-2B is
   running.
7. **Keep projections synchronized.** Re-export all new validators, types,
   bounds, proof metadata, and vectors through `wire/index.ts` and the
   package barrel. Bump only the contract package version to beta.8,
   regenerate checked-in contract output if its inputs change, and update
   package-facing conformance boundary tests.

## Required tests and acceptance evidence

The PR must demonstrate all four maintainer acceptance conditions at its
exact final SHA:

1. **Exact validation:** every H field accepts its minimum and maximum,
   rejects empty/N+1/wrong-type values, applies SemVer only to H3/H4, and
   rejects additional authority fields in hello/ready.
2. **Raw-byte proof:** each row has request/result/error
   `maxEncoded* < MAX_FRAME_BYTES`; its ASCII, multibyte, and escaping
   maximum cases fit; each leaf's N+1 candidate is rejected by its validator
   before it can be used as a valid frame.
3. **Pre-dispatch safety vectors:** invalid H values, oversize values, bad
   digest, and authority injection map to a closed rejection vector with
   `zeroSideEffects: true`; no vector represents a Host write or activation.
4. **Four-way agreement:** generated exports, registry metadata,
   conformance fixtures, and the packed artifact agree on the exact reviewed
   source SHA. The public-boundary and artifact toolchain checks remain part
   of the final gate.
5. **Ready-row disposition and workspace compatibility:** valid
   `broker.hello` and `broker.ready` requests classify as `T-M`, while their
   invalid forms remain `T-G`. The unconnected standalone shell responds
   conservatively after `T-M`; it does not activate a handshake. Existing
   reserved rows stay on their current reject path.

Run, at minimum:

```sh
pnpm --filter @clowder-ai/plugin-contract generate:check
pnpm --filter @clowder-ai/plugin-contract typecheck
pnpm --filter @clowder-ai/plugin-contract test
pnpm --filter @clowder-ai/plugin-contract conformance
pnpm --filter @clowder-ai/plugin-contract build
```

Then run the repository quality gate required by the PR template. A package
version change is not a registry publication: publication and all consumer
pins stay blocked until merge plus exact artifact integrity/digest
verification.

## Review and handoff

1. Fable approved the five grammar choices and the row-2 `null` result, with
   the `T-M` and SDK-passive-adaptation deltas above. Implement test-first in
   this worktree.
2. Obtain a cross-individual
   review (Sol or Kimi; never self-review).
3. Open the contract PR, link it to #1165, and register its review tracking.
   Maintainer review is against the PR's exact final HEAD.
4. After merge and registry integrity/digest verification, the Host may
   explicitly re-pin and start the handshake-first K-2B tranche. That is a
   separate work item, not an implied authorization from this PR.
