---
feature_ids: [F202]
topics: [migration, sdk, owner-threads]
doc_kind: implementation
created: 2026-10-12
---

# Strict owner thread SDK pairing

This is the first implemented Host401/422 slice, supplied by Host `d7f5613d4c93df4a90fc5e5ff936afbae242295a` / TREE `abf29957c1079d22d8d67534aa47a592c3f0cedc`, independently approved by Codex623. It mirrors the existing owner thread producer and injection; it does not redesign Collective business or activate the remaining11 owner/9 native handlers.

Contract manifest schema owns `PluginOwnerThread`, `PluginOwnerThreadCreateInput` and `PluginOwnerThreadAddParticipantsInput`; generated types and shared validators follow it. SDK `PluginOwnerThreadHost` exposes `get`, `create` and `addParticipants`. The optional member travels from `ModulePluginHostShape` through `FeatureHostAdapter` to `FeatureContext`. A supplied partial port is rejected; an older carrier remains absent, with no accessible-thread fallback.

The exact result is `{ id, createdBy, participants }`; `get` permits `null`. `create` accepts only a title (1..200 characters, no surrounding whitespace). Participant input contains a thread ID (1..500 characters, no surrounding whitespace) and at most50 unique string cat IDs, including an empty array. Current canonical cat availability and strict owner identity remain Host checks; this DTO does not prove the forthcoming native provider-supported roster. Existing participant projections can contain more than50 cats; the input limit is not imposed on accumulated output.

Host authentication/currentness/storage fencing remains in the authenticated owner webhook ALS. It strictly compares `thread.createdBy` with the authenticated configured owner, never a plugin binding or caller body. Reads use `thread.listMetadata`; writes use `thread.write`. SDK only adds feature grant/lifecycle guards before and after each awaited call and copies the validated owner projection into an immutable snapshot. No retry, authority synthesis, new capability, provider policy union or Task execution/CAS state is introduced. Ordinary create is not an idempotent ensure; post-effect revocation is not a rollback claim.

The new boundary does not change any plugin dependency declarations, production shrinkwraps, shared lock, or historical SDK12/15/19 artifacts. SDK20 and contract36 remain unpublished candidates at the verified official npm registry snapshot, so this source addition does not reuse published bytes. Packed candidate checks prove exported DTOs and module adaptation; they do not claim registry publication or actual installed Collective owner/native usability.

The remaining Collective caller adapters still need the independently implemented Host roster, exact source/current invocation facts, Work receipt/admission/dispatch and Task-bound publication reader. Their requested shapes and original callsites remain in the existing Host401/422 handoff. No not-yet-supplied export is guessed. The completed finite browser lifecycle receipt for Host857/package102 remains historical evidence for those exact inputs; these new SDK/contract bytes require new coordinates if used in a later installed journey.
