---
doc_kind: plan
created: 2026-11-03
updated: 2026-11-03
---

# Keep normal publication green and activation accountable

The accepted result is that a normal source PR, merge, npm publication and separate catalog PR do not make main fail merely because activation is pending. Preserve #97's protection against published packages disappearing from discovery follow-up. Do not bulk activate the catalog; Companion alpha.37 waits for its paired Host and complete desk-delivery acceptance.

## Release contract

`catalog/release-plans.json` owns the declared destination of a selected immutable plugin release. A new or changed candidate must declare `activate` or `defer`, a named owner, a review date and a public source reference. Deferral additionally explains the dependency and release condition. Identity includes plugin id, version and archive integrity; a record cannot excuse a later version or changed bytes. Historical plans remain provenance, not fresh permission.

PR validation checks the new selected versions and any unresolved existing candidates before merge. It performs no publication, installation or catalog writes. Expired existing waits are handled by the audit and do not block unrelated source PRs. A new or edited plan must have a future review date. An activation PR still uses the existing scoped archive verification and independent review.

The post-publication audit reports `active`, `activation pending`, `deferred`, `overdue` or `unowned`. Pending work is a release follow-up, not a failed npm upload. The daily/manual audit creates or updates one durable GitHub reminder per release, naming the responsible owner and linking its source; resolved reminders close automatically. Unchanged reminders are not reposted. Neither audit changes the live catalog. Actual upload, build, integrity or notification transport failures remain visible as failures; pending activation itself does not fail main.

## Delivery and verification

1. Reconcile all 14 old candidates against their source changes and actual Host archive admission. Activate each compatible published plugin through `catalog:activate:plugin`; retain Companion waits explicitly and trace alpha.36 separately.
2. Add the release-plan PR validator and audit with observed failing regression checks, then minimal implementation. Wire PR validation before the expensive gate, replace the publish job's strict completion step with a report, and make the scheduled audit deliver reminders.
3. Exercise the production CLI in an isolated Git/registry/notification fixture: undeclared source PR rejected; declared activate/defer PR accepted; merge and publish followed by a pending audit succeed; a later catalog PR resolves the matching reminder; expiry/unowned records still create actionable owner reminders.
4. Run the repository's affected checks and required `pnpm gate:ci`, obtain one independent non-author review covering the release-gate semantics, merge and verify a fresh main publication run plus the manual daily audit.

No new runtime service or external dependency is needed. Authors add a small release declaration when advancing a plugin version; this replaces post-merge red CI and prevents unrelated activation work from blocking one another. Package installation or runtime restart in the owner's daily environment is outside catalog activation; report discovery and installed versions separately.
