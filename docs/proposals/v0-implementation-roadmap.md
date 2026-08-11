---
title: Clowder AI plugin system implementation roadmap
status: EXECUTION REFRESH ACCEPTED — standing ownership rule confirmed; verified progress current through beta.9 and the dormant K-2D runtime draft
discussion: zts212653/clowder-ai-plugins#1
ack_request: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5236600431
acknowledgement: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5248175358
created: 2026-07-14
revised: 2026-08-11
feature_ids: [clowder-ai-plugins-init, P-1, F288, F292]
topics: [roadmap, plugin-contract, host-broker, standalone-io, signal-ingress]
doc_kind: roadmap
references:
  - docs/proposals/plugin-system-principles-and-v0-design.md
  - zts212653/clowder-ai#1165
  - zts212653/clowder-ai-plugins#23
---

# Clowder AI plugin system implementation roadmap

This is the execution truth source for the public plugin contract, SDK and
first-party plugins, and their Host-side convergence. It replaces the
2026-07-14 planning counts and assignments with verified progress through
`@clowder-ai/plugin-contract@0.1.0-beta.9`.

The architectural principles remain unchanged. This refresh changes only
status, execution order, and the standing authorship model.

## 1. Operating rules

1. **One contract truth source.** Host and plugins consume an exact published
   `@clowder-ai/plugin-contract` version. No core-local wire mirror may become
   a second protocol source.
2. **Contract return loop.** A wire slice becomes usable only after:
   `shape agreement → dual-CODEOWNER contract PR → exact package publication
   and integrity verification → Host exact pin + conformance → Host merge →
   acceptance`.
3. **A ready row is a machine claim.** `leafClosure: CLOSED` is insufficient by
   itself. A row is advertised only when the registry records `ready: true`
   and its validators, encoded-byte proofs, conformance vectors, and runtime
   enforcement agree.
4. **Default implementation authorship belongs to `mindfn` for unclaimed
   lanes.** `mindfn` may lead public contract, SDK, plugin, conformance, and
   roadmap work, plus Host/Core work where a writable contribution surface is
   available. This does not move Host-domain ownership: `zts212653` retains
   Host integration boundaries, review/merge authority, runtime
   responsibility, production data/credential decisions, and independent
   acceptance. Private Cat Café-only composition remains maintainer-owned.
5. **No self-review.** Public contract changes remain dual-CODEOWNER. When
   `mindfn` authors both plugin and Host halves, `zts212653` leads the final
   cross-boundary verdict.
6. **FG independence remains deliberate.** FG-1 and FG-2 remain
   `zts212653`-authored reference plugins unless both owners explicitly revise
   that acceptance design.
7. **No duplicate private work.** Before claiming a Host lane, the two owners
   disclose any active private branch/PR and choose one author. This is a
   collision check, not a new design gate. When private source is unavailable,
   `mindfn` leads the public seam, validators, fixtures, black-box vectors, and
   executable package; maintainers make the narrow private composition change.

Rules 4–7 are the standing ownership decision accepted by `zts212653` on
2026-08-11. Ordinary unclaimed work no longer needs a per-PR permission ping;
new public semantics, production data/credential boundaries, runtime
activation, irreversible registry actions, or a discovered collision still
return to maintainer review.

## 2. Current system map

| Phase / lane | Unit | Current truth | Gate still open |
|---|---|---|---|
| Phase 0 | G-0 values and contract foundation | **DONE.** Four policy sets are co-signed; package, CI, code generation, conformance, CODEOWNERS, and automated prerelease publication are live. | None. |
| Phase 1 / M0 | K-1 MessagingDomain | **DONE.** `clowder-ai#1270` merged as `3251eea`. | None. |
| Phase 1 / M0 | P-1 standalone plugin half | **DONE.** PRs #12, #13, #20, and #21 deliver the stdio runtime, S1 dispatch, manifest validator, S2 shell, S3 handshake client, S4 loopback fixture, and S5 adversarial matrix. | None on the plugin half. |
| Phase 1 / M0 | K-2A dormant Host foundation | **MAINTAINER-REPORTED DONE.** `zts212653` reports private `cat-cafe#3422` merged as `a6b38ac`, originally pinned to beta.7 with activation dormant. The private patch is not independently visible from this repository. | Superseded as an active gate by K-2B's exact beta.9 pin; retain only as provenance. |
| Phase 1 / M0 | K-2B Host Broker | **MAINTAINER-REPORTED LANDED, RUNTIME DORMANT.** Cat Café #3555 merged as `f7fe823`; the Host pins exact beta.9 and implements the contract-native state machine plus `events.publish` edge. | External process/stdio activation and real black-box acceptance remain off. |
| Phase 1 / M0 | K-2B lifecycle and messaging transport | **NOT CONTRACT-READY.** Rows 3–12 remain `ready:false`; several messaging rows still contain RESERVED leaves. | Close and publish the exact M0 row set, then implement the matching Host routes. |
| Phase 1 / M0 | K-2D external runtime | **DRAFT / DORMANT.** Cat Café #3558 is active at `894c4e4`; its generic supervised stdio/environment boundary is implemented. | Cat Café #3467 typed data-root catalog, then rebase, typed project persistence/restart wiring, full gate, non-author review, merge, and a separate activation decision. |
| Phase 1 / M0 | Joint acceptance | **NOT STARTED.** The plugin-side 18-case Host seam manifest is merged. | Real Host ↔ standalone plugin co-run, fail-closed matrix, and plugin-crash isolation verdict. |
| Phase 2 / signal ingress | C-2 signal-ingress slice + Feishu adapter | **PUBLIC HALF LANDED.** PR #24 merged as `9d4a76c`; beta.9 makes `events.publish` ready. `@clowder-ai/feishu-meeting-intake@0.1.0-alpha.1` is registry-visible with a reviewed stdio entrypoint. | External runtime activation and end-to-end dogfood remain separate gates. |
| Phase 2 / F292 | Host intake | **MAINTAINER-REPORTED LANDED.** Cat Café #3522 and #3542 merged as `55c663a` and `d603b76`, covering Host intake and Needs Me flow. | Production activation, credentials, and black-box verification are not claimed. |
| Phase 2 / F292 | Experience journey | **PRIVATE FLOW LANDED, EXTERNAL JOURNEY PENDING.** Needs Me exists in the Host, but the external runtime is dormant. | Activate only after K-2D closes; then run real meeting dogfood and collect release evidence. |
| Phase 2 / M1 | K-3b + P-4 + FG-1 | **PENDING; K-3b UNCLAIMED.** Collision scan found no active K-3b implementation; windows/presence, desktop probe, and foreground-cat reference plugin are not complete. | Contract closures, Host mechanisms, plugin implementations, M1 joint acceptance. |
| Phase 2 / collection | K-5 + C-3 + P-5 | **PENDING / UNCLAIMED.** Collision scan found no active K-5 implementation; schedule/state contract work and GitHub migration have not started. | M0 and the per-domain contract return loop. |
| Phase 3 | Service/UI, connectors, memory, community, v1 | **PENDING.** | M1 or the explicit per-lane prerequisites below. |

### Published row partition

| Release | Newly ready rows | Integrity |
|---|---|---|
| `0.1.0-beta.8` | `broker.hello`, `broker.ready` | `sha512-X3Si54oCuEN71K3EthHaZATjIphnUIXqGNDyxvOoN4lK/T193tIuxm8+jMf5MBrURNPbfaEmJneynVDGTgAbDg==` |
| `0.1.0-beta.9` | beta.8 rows plus `events.publish` | `sha512-YPpJguiVd0qdoOX8HdU26k36b+58zj0V9w02z/GpRnF8WBubfwuoZ5RBQPE2gf5qwSQwCl/+WVRhsMG/i65Epg==` |

Rows 3–12 are still not advertised. Therefore neither beta.8 nor beta.9 is
evidence that the complete M0 Broker surface is ready.

## 3. Immediate critical path: close M0

M0 is the only current critical path. Work proceeds in four independently
reviewable slices; later Phase 2 work may be drafted in parallel, but it does
not replace this gate.

### M0-A — Host handshake activation

- K-2B is already merged against exact beta.9; do not create another Host
  state machine, process manager, or protocol mirror.
- Finish K-2D through Cat Café #3558 after #3467 supplies the canonical typed
  data-root catalog: rebase, add typed project-scoped persistence/restart
  wiring, run the full gate, obtain non-author exact-HEAD review, and merge.
- Keep external process/stdio composition dormant until a separate activation
  gate authorizes it.
- At activation, run the published handshake byte-bound and zero-side-effect
  conformance against the real Host boundary.

### M0-B — lifecycle ready-row closure

- Advance only the lifecycle rows required by M0 (`host.grants.changed`,
  `host.lifecycle.ping`, and `host.lifecycle.drain`) after their exact
  validators, encoded-byte proofs, and runtime enforcement are present.
- Keep unrelated messaging rows reserved; a CLOSED leaf is not permission to
  advertise a method.
- Publish and verify the resulting exact package before the Host emits these
  methods.

### M0-C — messaging transport closure

- Trace the M0 Host seam and K-1 APIs to the exact required rows among
  `messaging.send`, `messaging.appendElements`, `messaging.subscribe`,
  `messaging.read`, `messaging.ack`, `messaging.snapshot`, and
  `host.messaging.deliver`.
- Close RESERVED leaves in contract-owned slices. Do not flip all rows merely
  to match the old PR count.
- Implement each ready slice against the K-1 MessagingDomain as the only
  ledger/cursor/message truth source.
- Consume the same contract fixtures from both SDK and Host; do not copy the
  18 behavior cases into a Host-local matrix.

### M0-D — independent joint acceptance

The maintainer-led verdict must show:

1. real Broker ↔ compiled standalone plugin handshake and activation;
2. every currently applicable case in
   `packages/loopback-fixture-plugin/test/host-half-seam-manifest.json` passes;
3. malformed, unauthorized, oversize, stale-cursor, cross-instance, and
   cross-subscription inputs fail closed with the required zero side effects;
4. plugin crash, invalid output, and drain failure do not take down the Host;
5. restart/reconcile preserves K-1 canonical state and does not double-settle.

Only this verdict closes M0.

## 4. Phase 2 execution lanes

### 4.1 F292 / signal-ingress journey

The original three-part split has advanced, but runtime activation still
separates landed code from feature acceptance:

1. **Contract + SDK + Feishu adapter — LANDED.** Beta.9 and PR #24 are merged;
   `@clowder-ai/feishu-meeting-intake@0.1.0-alpha.1` is public at integrity
   `sha512-KxdTlM24eKnXy6NE3TmbP78ro5D6lAX+m0H3LN4MrfI6SVz9BQnntHDxobjz4B+5wJ3gl0i7BX3ZOjBnhFby/w==`.
2. **Host intake + Needs Me — MAINTAINER-REPORTED LANDED.** Cat Café #3522 and
   #3542 own admission, settlement, and the private Host experience flow.
3. **External journey — PENDING.** K-2D remains dormant in Draft #3558; after
   its dependency/review/merge and a separate activation decision, run real
   meeting dogfood, provenance-preserving artifact checks, and release
   evidence.

The private-work collision check is complete. This lane now waits on the K-2D
runtime/activation boundary and its own end-to-end evidence; `events.publish`
readiness does not imply K-3b windows/presence or M1 is done.

### 4.2 M1 experience gate

| Unit | Standing author | Required outcome |
|---|---|---|
| K-3b windows/presence | `mindfn` draft; `zts212653` Host review/merge | B-class windows, presence/lease projection, grants and control surface |
| Remaining C-2 closures | `mindfn`; dual CODEOWNER | Only schemas/rows required by K-3b and probe/FG integration |
| P-4 desktop probe | `mindfn` | Tier 0/1 declared signals, lease behavior, visible/revocable authorization |
| FG-1 foreground cat | `zts212653` | Reference plugin using the same SDK/runtime/grant path as third parties |

M1 closes only when the real path
`file/activity signal → Host-owned wake → foreground cat → user confirmation →
artifact` passes and P14 same-power evidence is explicit.

### 4.3 GitHub collection gate

This lane remains independent from M1 and may be developed in parallel after
M0:

1. K-5 Host schedule/state domain — `mindfn` draft, `zts212653` review/merge.
2. C-3 schedule/state contract and migration/rollback fixtures — dual
   CODEOWNER.
3. P-5 GitHub plugin migration — `mindfn`, including complete mapping of
   config, secrets, state, schedules, and bindings.
4. Isolated acceptance proves idempotent migration, no old/new double-run,
   data preservation, and rollback. `zts212653` reviews the integrity report.

## 5. Phase 3 map

| Lane | Sequence | Standing authorship / authority | Gate |
|---|---|---|---|
| Service + UI | K-6 Host mechanism → contract delta → P-6 voice-suite | `mindfn` may draft; `zts212653` owns Host review/runtime; plugin and contract work dual-reviewed | M0; UI contribution passes Console Design Gate |
| Thread + connectors | K-7 thread/settings mechanism → contract delta → P-7 IM migration; P-8 Weixin may move earlier when its contract prerequisites exist | `mindfn` may draft; Host merge remains `zts212653` | M0 plus K-7 for P-7; exact schedule/state prerequisite for P-8 |
| Memory + foreground cat | #1047 acceptance → K-8 memory namespace → contract delta → FG-2 | #1047/K-8 Host authority with `zts212653`; fixtures by `mindfn`; FG-2 remains `zts212653`-authored | #1047 verdict; `cat_private` remains a hard exclusion |
| Community readiness | create-clowder-plugin, quarantine CI, signature/digest pipeline | `mindfn` | M1 |
| v1 freeze | Compatibility review and breaking-window closure | Both owners | All selected v1 lanes accepted |

## 6. Dependency view

```text
DONE: Phase 0 + K-1 + P-1 + beta.9 public ready rows
                         │
                         ├─ DONE: K-2B Host state machine (runtime dormant)
                         ├─ K-2D #3558 + #3467 dependency + review/merge
                         ├─ M0-A explicit external-runtime activation
                         ├─ M0-B lifecycle row closure + Host support
                         └─ M0-C messaging row closure + Host support
                                      │
                                      └─ M0-D joint acceptance ──► M0

DONE: beta.9 + Feishu alpha.1 + private F292 Host/Needs Me flow
                         │
                         ├─ K-2D activation ──► F292 external dogfood/release evidence
                         └─ K-3b + P-4 + FG-1 ──► M1

M0 ──► K-5 + C-3 + P-5 ──► GitHub collection gate
M1 / per-lane prerequisites ──► Phase 3 lanes ──► v1 freeze
```

The two Phase 2 lanes may overlap. Their acceptance gates remain independent.

## 7. Standing ownership decision

The six-item acknowledgement is complete in
`zts212653/clowder-ai-plugins#1` issue comment `5248175358`:

1. K-2B and F292 Host/Needs Me are landed; K-2D is the only active private
   runtime coordinate. K-3b and K-5 are unclaimed.
2. `mindfn` leads ordinary unclaimed work; `zts212653` retains Host
   review/merge, runtime ownership, integration boundaries, and private
   composition.
3. Dual-CODEOWNER contract review and exact publication/version/integrity
   verification remain mandatory.
4. `zts212653` leads independent acceptance whenever `mindfn` authored the
   implementation under test.
5. FG-1 and FG-2 remain `zts212653`-authored.
6. The old beta.8 choice is superseded: the current Host pins exact beta.9 and
   consumes only `broker.hello`, `broker.ready`, and `events.publish`.

This is the standing rule. Ordinary unclaimed implementation proceeds without
another authorship round trip. New public semantics, production
data/credential boundaries, runtime activation, irreversible registry
actions, or a discovered collision return to maintainer review.
