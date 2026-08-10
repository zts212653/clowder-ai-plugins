---
title: Clowder AI plugin system implementation roadmap
status: EXECUTION REFRESH PROPOSED — verified progress current through beta.9; authorship refresh pending maintainer acknowledgement in issue #1
discussion: zts212653/clowder-ai-plugins#1
ack_request: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5236600431
created: 2026-07-14
revised: 2026-08-10
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
status, execution order, and the proposed authorship model.

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
4. **Default implementation authorship is proposed to move to `mindfn`.** If no
   conflicting private branch exists, `mindfn` may draft any remaining
   roadmap implementation. This does not move Host-domain ownership:
   `zts212653` retains Host integration boundaries, review/merge authority,
   runtime responsibility, and independent acceptance.
5. **No self-review.** Public contract changes remain dual-CODEOWNER. When
   `mindfn` authors both plugin and Host halves, `zts212653` leads the final
   cross-boundary verdict.
6. **FG independence remains deliberate.** FG-1 and FG-2 remain
   `zts212653`-authored reference plugins unless both owners explicitly revise
   that acceptance design.
7. **No duplicate private work.** Before claiming a Host lane, the two owners
   disclose any active private branch/PR and choose one author. This is a
   collision check, not a new design gate.

Rules 4–7 are the proposed 2026-08-10 authorship refresh. They become confirmed
only after the maintainer acknowledgement requested in issue #1.

## 2. Current system map

| Phase / lane | Unit | Current truth | Gate still open |
|---|---|---|---|
| Phase 0 | G-0 values and contract foundation | **DONE.** Four policy sets are co-signed; package, CI, code generation, conformance, CODEOWNERS, and automated prerelease publication are live. | None. |
| Phase 1 / M0 | K-1 MessagingDomain | **DONE.** `clowder-ai#1270` merged as `3251eea`. | None. |
| Phase 1 / M0 | P-1 standalone plugin half | **DONE.** PRs #12, #13, #20, and #21 deliver the stdio runtime, S1 dispatch, manifest validator, S2 shell, S3 handshake client, S4 loopback fixture, and S5 adversarial matrix. | None on the plugin half. |
| Phase 1 / M0 | K-2A dormant Host foundation | **MAINTAINER-REPORTED DONE.** `zts212653` reports private `cat-cafe#3422` merged as `a6b38ac`, pinned to beta.7 with activation dormant. The private patch is not independently visible from this repository. | Re-pin and activate only against a reviewed ready-row release. |
| Phase 1 / M0 | K-2B handshake activation | **CONTRACT READY, HOST PENDING.** PR #22 merged as `c6c59fa`; beta.8 makes only `broker.hello` and `broker.ready` ready. | Host implementation/pin/conformance and independent review. |
| Phase 1 / M0 | K-2B lifecycle and messaging transport | **NOT CONTRACT-READY.** Rows 3–12 remain `ready:false`; several messaging rows still contain RESERVED leaves. | Close and publish the exact M0 row set, then implement the matching Host routes. |
| Phase 1 / M0 | Joint acceptance | **NOT STARTED.** The plugin-side 18-case Host seam manifest is merged. | Real Host ↔ standalone plugin co-run, fail-closed matrix, and plugin-crash isolation verdict. |
| Phase 2 / signal ingress | C-2 signal-ingress slice + Feishu adapter | **DONE FOR PR 1/3.** PR #24 merged as `9d4a76c`; beta.9 makes `events.publish` ready and ships SDK helpers plus the official Feishu meeting-intake adapter. | Host admission/intake and user journey are separate PRs. |
| Phase 2 / F292 | Host intake | **PENDING / PRIVATE STATUS UNKNOWN.** K-3a admission, source-grant verification, durable `MeetingIntake`, health, and repair truth. | Collision/ownership confirmation, Host PR, conformance. |
| Phase 2 / F292 | Experience journey | **PENDING.** Needs Me projection, private-thread journey, real meeting dogfood, and release evidence. | Host intake merged and real acceptance data. |
| Phase 2 / M1 | K-3b + P-4 + FG-1 | **PENDING.** Windows/presence domain, desktop probe, and foreground-cat reference plugin are not complete. | Contract closures, Host mechanisms, plugin implementations, M1 joint acceptance. |
| Phase 2 / collection | K-5 + C-3 + P-5 | **PENDING.** Schedule/state domain, schedule/state contract delta, and GitHub migration have not started. | M0 and the per-domain contract return loop. |
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

- Confirm no conflicting private K-2B implementation exists.
- Reuse the K-2A dormant Host seam; do not create another process manager or
  protocol mirror.
- Pin one exact contract artifact:
  - beta.8 for a handshake-only Host PR; or
  - beta.9 if the same Host dependency also consumes the already-reviewed
    `events.publish` contract.
- Implement snapshot-before-validation at the Host authorization boundary.
- Run the published handshake byte-bound and zero-side-effect conformance.

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

PR #24 is PR 1/3, not feature completion:

1. **Contract + SDK + Feishu adapter — DONE.**
2. **Host PR — PENDING.** K-3a admission, declaration/grant verification,
   canonical source-handle equality, durable idempotent intake, health, and
   repair truth. The Host owns credentials, destinations, and all wake policy.
3. **Experience PR — PENDING.** Needs Me only for unresolved choices, private
   thread resolution, provenance-preserving artifacts, real meeting dogfood,
   and release evidence.

This lane may proceed alongside M0 after the private-work collision check. Its
`events.publish` readiness does not imply K-3b windows/presence or M1 is done.

### 4.2 M1 experience gate

| Unit | Default proposed author | Required outcome |
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

| Lane | Sequence | Proposed authorship / authority | Gate |
|---|---|---|---|
| Service + UI | K-6 Host mechanism → contract delta → P-6 voice-suite | `mindfn` may draft; `zts212653` owns Host review/runtime; plugin and contract work dual-reviewed | M0; UI contribution passes Console Design Gate |
| Thread + connectors | K-7 thread/settings mechanism → contract delta → P-7 IM migration; P-8 Weixin may move earlier when its contract prerequisites exist | `mindfn` may draft; Host merge remains `zts212653` | M0 plus K-7 for P-7; exact schedule/state prerequisite for P-8 |
| Memory + foreground cat | #1047 acceptance → K-8 memory namespace → contract delta → FG-2 | #1047/K-8 Host authority with `zts212653`; fixtures by `mindfn`; FG-2 remains `zts212653`-authored | #1047 verdict; `cat_private` remains a hard exclusion |
| Community readiness | create-clowder-plugin, quarantine CI, signature/digest pipeline | `mindfn` | M1 |
| v1 freeze | Compatibility review and breaking-window closure | Both owners | All selected v1 lanes accepted |

## 6. Dependency view

```text
DONE: Phase 0 + K-1 + P-1 + beta.8 handshake contract
                         │
                         ├─ M0-A Host handshake activation
                         ├─ M0-B lifecycle row closure + Host support
                         └─ M0-C messaging row closure + Host support
                                      │
                                      └─ M0-D joint acceptance ──► M0

DONE: beta.9 events.publish + Feishu adapter
                         │
                         ├─ F292 Host intake ──► F292 experience journey
                         └─ K-3b + P-4 + FG-1 ──► M1

M0 ──► K-5 + C-3 + P-5 ──► GitHub collection gate
M1 / per-lane prerequisites ──► Phase 3 lanes ──► v1 freeze
```

The two Phase 2 lanes may overlap. Their acceptance gates remain independent.

## 7. Maintainer acknowledgement requested

Before new production implementation starts, issue #1 should record one
complete response covering:

1. whether any private K-2B, F292 Host, K-3b, or K-5 implementation is active,
   with branch/PR coordinates sufficient to avoid duplicate work;
2. whether the default authorship rule is accepted: `mindfn` drafts an
   unclaimed implementation, while `zts212653` retains Host review/merge,
   runtime ownership, and integration boundaries;
3. whether dual-CODEOWNER contract review and exact publish/integrity gates
   remain unchanged;
4. whether `zts212653` will lead M0/M1/GitHub-gate acceptance when `mindfn`
   authored the implementation under test;
5. whether FG-1/FG-2 remain `zts212653`-authored;
6. for the first Host PR, whether it is handshake-only on beta.8 or combines
   handshake with the already-published beta.9 signal-ingress dependency.

After that acknowledgement, ordinary implementation proceeds without asking
for a new ownership decision on every PR. Only new public semantics,
production data/credential boundaries, or a discovered private-work collision
return to joint decision.
