---
title: Preserve and reconcile final pull request provider facts
created: 2026-11-06
status: implementation
---

The accepted result is a durable, rebuildable view of a merged or closed pull request's final provider HEAD, review commit associations, merge identity and actual CI provenance. Historical native delivery and assignment records remain historical records. A provider approval cannot create native delivery.

Architecture cell: GitHub provider → existing Community event journal → existing projection and inspection read model.
Map delta: add a provider-only terminal observation within these owners and one bounded native reconciliation action; no new store, service, scheduler or review lifecycle.
Why: existing terminal collection discards final facts, and retrying an active verdict is correctly fenced after closure.
Canonical source: `CommunityEventLog.ts` and `community-projector.ts`; provider observations do not own native verdicts.
Consumer evidence: `rg -n 'observeTracking|collectTracking|providerObservation|fetchPrState|emitCommunityEventLogOnly|graphQlPrToPollResult' packages/github-operations/src` covers single/batch tracking, webhook, reconciler, inspection and CI readers.
Claim guard: terminal provider observations preserve final facts and cannot open review work → production-entry tests of collection, projection/rebuild, reconciliation and installed-package native dispatch → RED when final HEAD/review/CI is absent or historical delivery/ownership changes.

1. Reproduce final-fact loss at the real CommunityRuntime and GitHubProvider boundaries. Use in-memory Host storage, no production state. Keep a trustworthy RED, then repair the production path.
2. Carry typed terminal facts, including source/subject/commit-bound CI and review commit IDs. Use a deterministic journal event and an optional rebuildable projection field. Partial observations enrich known facts; older observations cannot erase newer information or turn merged into closed/open. Native last-delivered, reviewer identity, terminal fence and failure evidence are unchanged.
3. Preserve the same facts from tracking, verified webhook payloads and repository reconciliation. Fetch real terminal CI for exact and batched readers, including pagination. Missing checks are unknown/empty evidence, not a reported running CI or a pass.
4. Expose one authenticated, repository-configured action taking only an existing PR subject. It re-reads GitHub under current caller/lifecycle fencing and appends only terminal provider facts. It cannot accept supplied facts, register tracking, wake reviewers or write a delivery verdict. Invalid/mismatched subjects, commits, CI or incomplete provider reads cannot become positive evidence.
5. Run package typecheck, affected behavior suites, independent non-author review, and a fresh tarball consumer through actual native action dispatch and readback/rebuild. Candidate validation uses disposable storage; no public package or production migration is performed by this change.

Cost: a small additional journal fact per distinct terminal observation; no resident process or new polling lane. Existing terminal reconciliation may read reviews and CI once when final facts are absent. The explicit historical repair costs one bounded provider read and never revives old subscriptions. This pays for preserving facts which are otherwise irrecoverable from the current journal.

Validation commands come from this repository: `pnpm --filter @clowder-ai/github-operations typecheck`, `pnpm --filter @clowder-ai/github-operations test`, `pnpm --filter @clowder-ai/github-operations build`; source behavior tests run with `node --import tsx --test`. Candidate verification uses `npm pack` and an isolated `npm install` of that tarball. Repository commands provide no formatter beyond TypeScript lint; `git diff --check` checks edited whitespace.

The implementation, independent review and candidate consumer are authorized here. Publishing, merging a branch that triggers publication, catalog activation, installed-runtime upgrade and production historical reconciliation require their own existing authorization to be verified after the candidate is reviewable.
