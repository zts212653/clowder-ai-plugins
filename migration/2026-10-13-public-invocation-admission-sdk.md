---
feature_ids: [F202]
topics: [plugins, sdk, collective, authority]
doc_kind: implementation
created: 2026-10-13
tips_exempt: "Internal mirror of the existing Host admission ABI; no new user or MCP action."
---

# Existing Host public admission mirror

Original Task1843 / accepted source094 and Host1439 deliver one implemented port:
Host `478014ecc10d3cffd9891cbb78ae83d610926d85`, approved by Codex1436.
Package baseline is `a033283349d8bbf584974e5533035084834a2599`.
The operator's C1 endpoint remains isolated Host installation of the local package
directory and use of the original functions. This is one required SDK edge in that work.

Architecture ownership: Host owns existing Message/Queue/custody/admission/currentness;
SDK mirrors the optional port through ModulePluginHostShape → FeatureHostAdapter → FeatureContext;
Collective owns Service source, participation, route and reply semantics.
Map delta: none; no new store, worker, scheduling authority or settlement protocol.

The port accepts only messageRef/targetCatId/native/authority and returns only the matching
messageRef, Queue entryId and queued/processing/terminal status. Input snapshot precedes Host
awaits, methods may arrive unsorted (Host canonicalizes), authority revision stays opaque,
and both existing send/content grants plus feature lifetime are checked before and after.
Host errors remain unchanged; no automatic retry or rollback claim. Older carriers retain
absence; a supplied incomplete port fails closed. Receipt does not certify business delivery.

Host queued exact-child read fix `37a6536` changes authorization implementation, not the existing
sourceFacts/nativeContext ABI. Their SDK mirrors therefore need no new DTO. The private verifier
remains isolated and cannot borrow owner/native ALS. Collective's reconsideration purpose winner,
original source access, invocation-bound opaque refs and private Work receipts are not invented
by this mirror. Native9/MCP and staged entry/pair/reconciler remain unregistered at this boundary.

Verification: module-chain regressions cover missing port RED → complete mirror GREEN, all three
statuses, detached/frozen snapshots, old carrier absence, partial carrier refusal, both grants,
hostile identity/coordinate/getter/prototype/symbol/sparse inputs, Unicode/UTF-16 bounds,
Host refusal without retry, late stop and exact receipt projection. Full affected SDK/Collective
checks and packed empty-consumer runtime/types are recorded in the original finite-closeout
evidence directory. Packed fixture proves SDK delivery, not authenticated Host installation.

Versions/pins/locks/contract/catalog/Collective business and active manifest remain unchanged.
The new unpublished SDK beta.20 bytes need their own packed digest and later installed receipt;
they do not inherit prior a033 cloud or older directory acceptance.
