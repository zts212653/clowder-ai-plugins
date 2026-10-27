---
title: F290 Work date, progress and source-material receipt regressions
date: 2026-10-27
status: review-ready-installed-reacceptance-pending
owner: codex61-sol
source: thread_mvq0gw651w05iglj#0001793064771445-000095-8a6eb884
---

An installed private Work invocation successfully wrote `plannedStart` to the original Service Work, then received HTTP502 because its own write advanced the business revision captured by the wake notice. The real invocation stopped instead of claiming success or repeating the operation. This patch preserves the exact wake-delivery observation while rechecking the same current assignment, execution revision, Human, connection, participant and original open Task for subsequent native actions. Business dates still use their original expected revision and operation replay.

The actual Alpha proof is in Core `docs/evidence/2026-10-27-f290-dates-materials/release/alpha-native-private-tool-receipts.json` and `alpha-native-private-after-time-failure.json`: invocation `c0febbc8-6411-4d85-99d8-c54d9676e147`, original Task `0001793081633033-000011-a15d0b81`, original Work `work_80ed0b99cccd4132a071fc073196584a`, Service revision5→6. Its deadline stayed at 2026-11-07 12:00 America/Los_Angeles; private Task dates remained empty. No new Task or execution grant was created.

## Source and package

This is a forward patch on merged #118 `de496d1c9c08dc4fdd4a18d5b46bec9b0de6e544`. Collective alpha.14 is already published; the patch uses alpha.15, retains Contract0.3/SDK0.3-beta.1 and does not restore API permission or method tables. No other package identity or live catalog is changed. The candidate adds one version object and preserves every existing object byte-for-byte at the JSON value level.

Client assets are unchanged: sourceBaseHead `5f055fcc907a67f015bceb84500256d8ad41e65d`, 542 checked inputs, no overrides, assetDigest `e4f49753dad6bb564d6b534d28493141d91b32cee17dae2c0982939cdb5ae7a1`. No browser layout or date/material schema is changed. The original Task/Service data and installed package instances are retained for reacceptance.

## Verification

- Exact regression RED: the production Service and Connector applied the date write; the real source-bound private native handler then threw `COLLECTIVE_WORK_WAKE_NOT_CURRENT`. `/tmp/f290-work-wake-time-red.log`.
- Targeted GREEN: 27 tests cover receipt return, exact operation replay, stale distinct CAS, strict delivery, future observation, changed assignment/execution, terminal Task, progress replay, observed actual start and connection revocation, together with the existing Work and date guards. `/tmp/f290-work-wake-time-green.log`.
- Package build/typecheck pass. Complete package tests pass: lifecycle6, control59, transport3, Business97 files/414 tests, zero failures/skips. `/tmp/f290-work-wake-time-{build,typecheck,package-green}.log`.
- Fresh packed consumer1/1 passes with its own installed dependency closure and real SDK lifecycle/MCP inventory. It is an isolated SDK consumer, not installed Host or account acceptance. `/tmp/f290-work-wake-time-installed.log`.
- Catalog validation/immutable-history/locked-dependency checks pass60/60 under the pinned publication toolchain. `/tmp/f290-work-wake-time-catalog-pinned.log`.
- Client source-continuity passes. `/tmp/f290-work-wake-time-source.log`.
- Canonical artifact uses repository-pinned Node24.18.0/npm11.16.0; metadata and SHA256 are in `/tmp/f290-batch2-time-receipt-identity.json`. Direct non-pinned local pack identities are not canonical publication evidence.

The old roundtrip test's existing in-memory Host setup was moved unchanged to `message-work-roundtrip.fixture.ts`; the original sixteen tests still run. Production Service/Connector are real in these tests, while Host identity/Task ports are explicitly controlled fixtures.

## Remaining delivery boundaries

This PR does not close Task3008. Real private dates/progress and Host-restart recovery must be repeated after the immutable patch package is installed on the SAME named Alpha. The existing owner is finishing Core #6236 / full Host Contract0.3 intake in `thread_mvq79pxua8m2a1m3`; the original Alpha still loads Contract0.2 and must not be forced to accept the new manifest.

The separate real public invocation `178f062c-ed88-420a-bade-2c4d73ee96a5` has read the Project and PR subject and returned an accepted public reply. Its material suggestion persisted revision5 but also returned unknown502; its HTTP request lasted10181ms against the ordinary10s transport deadline. A selected-material read was also reloading unrelated sources. The incremental regression reproduced both mechanisms: four owner reads for a two-operation single-material journey, and a committed source-backed mutation losing its receipt to the ordinary wire timeout. The delta filters the selected material before owner IO and gives only project-source/material-suggestion requests a bounded25s owner-relay budget. Publication reauthorization, source witnesses, CAS, ordinary request limits and unknown-effect handling are retained. Real installed reacceptance remains open; no further model sampling is launched before the paired source changes are loaded.

No F292 package publication, real meeting account/PhaseD, production deployment, runtime3001/3002, Redis6399, or parent Task mutation is performed here. Human visual acceptance remains deferred under the original authorization.

## Public material delta after the first approval

The earlier exact approved source remains `f6bb7e9810408d8112821746649df902a6c22b38`; its unpublished candidate identity is retained at `/tmp/f290-batch2-time-receipt-f6bb7e98-identity.json`. The new production delta is limited to `business/connector/service-client.ts` project-source/material suggestion methods, `business/service/project-source.ts`, and `business/service/project-material-store.ts` selected participant reads. No public schema, Host port, dependency or Client input changes.

`/tmp/f290-project-source-focused-red.log` records2/2 matching RED; `/tmp/f290-work-wake-material-delta-green.log` records30/30 targeted GREEN, including the existing private receipt guards. The source relay itself remains bounded at10s; the outer material request now leaves room to return its typed result. The ordinary metadata request still times out at its configured limit and no mutation is retried automatically. Unknown/unpublished material IDs cause zero provider reads.

The large existing ServiceClient remains an endpoint facade over one request primitive; the delta adds two per-operation budgets. The material store retains the existing shared publication authorization/observation transaction path; its exact-ID filter adds no parallel cache or authority. No broad facade/store rewrite is mixed into this patch.

The incremental build/typecheck, full package suite (lifecycle6/control59/transport3, Business98 files/416 tests) and fresh installed dependency closure1/1 pass. Logs: `/tmp/f290-work-wake-material-delta-{build,typecheck,package-green,installed}.log`. These supersede the earlier package counts only; the first approval and its artifact remain historical evidence. The refreshed canonical identity is recorded separately at `/tmp/f290-batch2-time-receipt-delta-identity.json` and will require a new exact-HEAD delta verdict before merge.
