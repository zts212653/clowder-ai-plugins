---
title: Collective business move and module lifecycle checkpoint
feature_ids: [F202, F290]
topics: [collective, migration, lifecycle, local-directory-install, authority]
doc_kind: implementation-plan
created: 2026-10-10
tips_exempt: Private migration checkpoint with no released Settings capability; owner onboarding and delivery remain in original aggregate1843.
---

# Original aggregate1843 implementation checkpoint

The original aggregate continues under Sol/cat-eqdvbcxw. This is an internal implementation/review
checkpoint, with no W4/Collective/C1 completion, publication, catalog admission, or operator acceptance.
The package remains private. Subsequent work extends this module and its moved business implementation.
The repository package ledger classifies it as `manager-installable-private-development`, with
`releaseAdmission=false` and `fullInstalledAcceptance=false`; it remains absent from the catalog.
The existing source inventory guard now requires those fields and actual `private:true` for this
classification, while retaining all public Manager artifact and capability disclosure checks.

## Accepted sources and writer boundary

Original Task: `0001789822127811-001843-1c2133b0`. The requirement is whole-business migration,
then adaptation at named generic Host/SDK edges. Custom Client UI/C2 and Host Task/custody/principal
authority remain in their original lanes. Host removal already happened under operator Host043;
the original September19 delete-after wording does not authorize restoring old Host business.

Source correction264 pins the pre-deletion feature commit `ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`.
Codex's typed332 approved only the R3 reverse-consumer census P1, with 1664 scoped dispositions,
125 retained Client/C2 rows, 14 shared declaration candidates, and 21 pending browser rows.
It did not approve implementation or public SDK types.

Existing-owner writer continuation344 is
`thread_mrkn6povq4zzgh45#0001791628175747-000344-6c7e88b4` (accepted revision is that immutable message).
It releases the frozen W3 package sequence to original aggregate owner, explicitly asks for the first
module start/stop/disable/failed-start cleanup sample and local-directory installation, and keeps all
remaining acceptance in1843. It does not revive215 or transfer W3/browser work.

Writer checkout: `/Users/lang/workspace/github-lab/clowder-ai-plugins-collective-sol`,
branch `feat/f202-collective-module-sol`, base `5dd199e5d3637e7650f4f9b98333c48ac72f0ab7`.
W3 and Host checkouts are read-only dependencies, frozen at5dd199e and
`93fee4342cf7296e5ec8def9d9cc8ae2754be49f` respectively. All development/build/validation uses this
feature checkout; fresh consumer/inventory/data directories are disposable test outputs, not other code
checkouts. Reserved runtime ports and production Redis are untouched.

## Move first, then adapt

Pure move commit `4952f27c9306d34cae35cd44b672803f11ed4f48` preserves 127 source blobs:
113 connector/service source and tests, plus14 domain declarations. The
[move record](../../migration/collective-source-move.json) pins source paths, modes, Git blobs, and SHA256.
It deliberately copies no125 Client/C2 files or generic reverse-consumer Host context.

The adaptation uses package-local domain imports. It removes generic Host entrusted-work schema imports
from the moved declaration and retains only the standing-work domain schema actually consumed here.
No Host schema is reimplemented, no shared/SDK public type is added, and no SDK/contract version is changed.
The source continuity guard separates62 unchanged blobs,52 mechanical import moves, and13 explicitly named
semantic/test edges. The13 edges require independent judgment; the guard does not approve their semantics.

Named production edges are Client-free backend HTTP, package-local GitHub setup result type, C2 protocol
label injection, actual-listener OAuth callback configuration, private startup credential escrow, and
retirement of the ambient HOME/env CLI. Seven regression-fixture adaptations preserve business assertions
and replace retained Client-only expectations with explicit C2-unavailable behavior.

## Lifecycle and recovery contract

`plugin.yaml` declares a builtin module, canonical default `create()` entrypoint, one backend feature,
only `data.directory`, and status/recovery operations. The transport adaptation at87ba2b8 removed
all configuration reads and service port/origins/public-URL overrides. Settings operation declarations
do not supply configuration values. The module receives its directory only from SDK authority and
uses the Host browser-service binding for origin, protocol/build identity and limits. Invalid bindings
and reserved3001/3002 reject before service-state creation. The obsolete `plugin.config.read` request
is removed under the actual-caller/minimal-grant pairing in Host076/078; Host owns its policy separately.

The Host owns the loopback listener and Client assets; the package opens no listener. Activation
validates the binding before publishing actions; bootstrap-link failure publishes no actions and
acquires no package listener. Stop/disable revoke actions; SDK stop is idempotent. Re-enable opens
the same service identity/state. No Host principal or Task identity
is fabricated; service/human/Collective identities are the original business domain's persisted identities.

The initial bootstrap factory escrows its one unclaimed credential in a0600 private file and fsyncs it
before state creation. Existing store defaults and authentication transitions are unchanged. A failed
start can retry with the same service identity and credential; it does not rotate or reopen a consumed
owner bootstrap. The link is atomically replaced for the Host-bound origin, and the private
credential is removed on stop or startup after consumption. Status never returns the credential.
Expiration follows the original domain policy; this checkpoint does not introduce an owner reset API.

Architecture cell: **Collective package-owned service/connector business + existing generic Host module
carrier**. Map delta: **package ownership moves out of removed Host; no new Host/SDK authority cell**.
Why: existing carrier lifecycle can own this checkpoint's in-process service and supplies the authorized
data directory. The new composition extends the moved service rather than another manager. Release
topology remains subject to the listener-consent and state-write measurements recorded below.

## Evidence and risk coverage

- `typecheck`: production and all moved regression fixtures.
- `test`:3 real lifecycle/failure/recovery tests and124 business tests in29 suites, zero skip.
- `test:source`: all127 move hashes and mechanical-import/named-edge classification.
- `test:installed`: exact local SDK/contract tarballs plus actual directory installation into an empty npm
  consumer; physical package/dependency imports, manifest/default entrypoint, every built JS module,
  backend bootstrap/create/disable/re-enable, retained C2 response, private modes and listener release.
  Native ESM business imports must fail at the installed package root; internal subpaths are not exported.
- With explicit `F202_COLLECTIVE_HOST_ROOT`: actual production local-directory admission, actual file
  inventory reload, local/untrusted source provenance and shipped dependencies, production builtin module
  carrier's failed-start/retry/bootstrap/disable/re-enable using fresh temporary Host state. This is a
  component integration, not the running Host or Settings/browser acceptance.
  The probe records five direct dist input hashes and their frozen source hashes/Git blobs. Those hashes
  identify the loaded build; they do not substitute for fresh-build or complete transitive-build evidence.

Behavior risk is runtime composition; data risk is fresh private business state and startup recovery;
security risk is bootstrap escrow and existing HTTP authentication; contract risk is default entrypoint,
canonical manifest and exact dependency closure; irreversible risk is none in this local private checkpoint.
Targeted tests cover these claims. No shared SDK/contract/core code changes occur. A whole-repository release
gate is not substituted by this package gate. Plugins-specific fallback/architecture/tips checker scripts
do not exist in this checkout; the ownership and exemption above are explicit review inputs.

## Original aggregate stays open

Host route/tool adapters, SDK messaging/storage projection, retained Client UI launch/HTTP forwarding,
source provenance displayed in Settings, no-double-execution across the full installed journey, and all
21 browser/journey dispositions are still work in1843. The first module and actual local-directory
composition are ready for independent review; they do not silently close those requirements.
Any concrete missing neutral Host edge returns with caller/source evidence to the original Host writer;
this checkpoint grants no edits to the frozen Host tree.

The original missing-package2-fail RED is preserved as historical prerequisite evidence. Actual behavior
REDs separately demonstrate leaked post-listen ports and lost retry bootstrap; new GREENs prove their fixes.
Latest logs, hashes, paired Host coordinates and gate report are in the original handoff evidence directory.
Operator experience, fork soak, Linux release packing, publication and merging remain distinct later gates.

## One-shot review379 disposition and continuation

Opus reviewed exact `6195106b4ce30accf4ceef5e0be7565fcf53252d` in
`thread_mrkn6povq4zzgh45#0001791632363246-000379-0c474c2f`: one blocking B1 (P2), with the
13 semantic edges and in-process builtin accepted for this checkpoint. The persisted message contains
the verdict in prose; no `localReviewFact` was returned by message/history readback. Repair review must
produce a durable typed verdict for its exact new HEAD; the prose receipt is not promoted into that fact.

| Item | Disposition, owner and trigger |
| --- | --- |
| B1 | Root exports narrowed to module factory/default/options only. Installed native ESM import rejection is RED before repair and must be GREEN after rebuilding. Daily independent reviewer verifies the repair. |
| N1(a), release gate | Aggregate1843 retains the dependency. Before `releaseAdmission=true`, original Host/contract owner must supply explicit listener disclosure/consent through the installation contract. README now discloses loopback and in-process operation; this does not implement capability consent. |
| N1(b), release gate | Aggregate1843 package owner measures whole-state serialization/fsync and Host event-loop impact using representative state sizes and traffic before release admission. If the result requires an external process, pair the exact caller with original Host/contract owner for authorized data-directory support; do not bypass authority inside the package. |
| N2, next C2/onboarding state | Aggregate1843 pairs activation/status with original C2/Host owner: verify escrow against persisted digest/expiry and expose pending/expired/unrecoverable states. Any unclaimed-secret rotation is a separate business change requiring its own behavior RED; no reset or rotation is introduced here. |
| N3 | Same-round probe records direct dist SHA256 and frozen tracked source SHA256/Git blobs. Reviewer379's source/build comparison supports the prior run; hashes identify subsequent runs without claiming fresh-build equivalence. |
| N4 | README names retirement of `COLLECTIVE_SERVICE_HOST` and `COLLECTIVE_GITHUB_CLIENT_ID/SECRET`, fixed loopback and App Manifest configuration. Aggregate1843 and original Settings owner decide secret configuration at Settings composition. |
| N5, next C2 composition | Aggregate1843 and original C2 owner establish one source for `clientBuildId` or a parity guard when Client composition lands. Current value remains the source protocol label, without a Client delivery claim. |
| Nit | Move the Zod import before the package-local result interface; no semantic change. |

These items remain in original1843. No new W4 task, W3 transfer, public domain type, SDK/contract bump,
release admission or frozen Host product write is authorized. Ordinary repair review goes to the daily
reviewer; one-shot architecture calibration is reopened only for a new architecture issue.
