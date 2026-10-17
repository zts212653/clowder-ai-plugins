---
feature_ids: [F202]
topics: [plugins, participant-roster, sdk, migration]
doc_kind: implementation-handoff
created: 2026-10-12
tips_exempt: Internal contract/SDK pairing and staged original business caller; no new user-facing operation or MCP tool is activated.
---

# Participant roster — Host858e91c4 pairing

Original Task1843, Host401/422/711. The implemented Host858e91c4 port and Codex704 approval are the source for this second optional port. Before: old Host registry/provider logic supplied Collective entry cards. After: Host supplies bounded public rows and honest supported values through participantRoster; package retains its original card names, sorting, fingerprint and pairing validation. Host retains authenticated owner/native scope, contribution admission, instance/method policy, grants, currentness and safe avatar projection. No new capability, Task state or provider union.

Contract DTOs PluginParticipant/PluginParticipantRosterInput mirror only package-facing fields. SDK module/feature adapter and optional facade transport the sole method, reject partial carriers, preserve Host errors/no retry, fence stop/late responses and return detached frozen public rows. Input is exactly one trimmed UTF-16-bounded contributionId. No eligible field is introduced in the public SDK DTO.

The old registeredCollectiveCats and entryRoster functions are copied with unchanged bodies from ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7 into packages/collective-connector/src/entry-control.ts. Their original display-name qualification/disambiguation, supported-to-eligible business projection and fingerprint remain package-owned. The new wrapper maps catId to old id and invokes the real roster on each read/pair; pairing body/schema/status/duplicate error/exclusions retain the old behavior.

This caller is staged, not registered in plugin.yaml or current plugin-entrypoint: the production native MCP declaration/actions and remaining native authority are not yet paired. The existing eleven owner webhook declarations and false native verifier remain unchanged. It cannot be exercised against the real Host roster until a unique declared MCP contribution with actions/granted owning feature is admitted. Do not use a guessed contribution identifier or activate missing native handlers to evade this boundary. This is extension of the original migration, not a new feature or C1 terminal.

Architecture cell: plugin host-surface and plugin-owned Collective business edge. Map delta: no new authority/store; public optional Host port mirrors existing implemented injection. Five axes: behavior=public DTO and staged caller; data=detached public rows only, no persistence changes; security=Host retains principal/admission/grants, SDK adds stop guards; contract=two generated schema definitions plus optional port; irreversible=none, no publish/merge.

Dogfood boundary: actual packed contract/SDK in an empty consumer with an injected Host fixture; staged caller regression retains real old business validation. Neither fixture establishes owner ALS, provider enforcement, installation or page acceptance. All original remaining owner/native/Work/meeting and publication work stays open. The old R4 receipt remains bound to Host857/package102 and does not sign these new SDK/contract bytes.
