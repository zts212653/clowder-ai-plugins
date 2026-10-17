---
feature_ids: [F202, F292]
topics: [plugins, meeting-intake, migration, lifecycle, authority]
doc_kind: implementation-plan
created: 2026-10-11
architecture-cell: plugin
tips_exempt: Package README and declared MCP tool descriptions carry discovery; this package change does not alter the Host capability-tip seed or claim installed acceptance.
---

# Meeting intake: owned records, SDK notification and installed MCP

Status: original Task1843 implementation in progress. The production manifest now selects
an actual builtin control module and two declaration-activated MCP readers. The original
record/notification, outbox/cursor and catch-up algorithms are connected. Directed production
module, credential isolation and owned subprocess fixtures pass (102/102). The final canonical
packed empty consumer starts the actual module, MCP and pinned runner; typecheck and inventory
checks pass. Independent source review and actual Host/account acceptance remain pending. No actual Feishu account, installed Host journey, release
or C1 completion is claimed. The author remains the sole package writer; Host installation
and concrete Host wiring remain its existing owner.

## Accepted goal and applicable source

The current C1 contract's **overview takes precedence over its old later sections**:
`docs/plans/2026-09-21-f202-c1-contract.md` in the Host feature checkout, overview
“迁什么” row11, plugin work c″, per-package meeting row and completion criteria.
It requires redesign rather than moving the obsolete Needs Me workflow: SDK send
notifications; plugin-owned meeting records and registered MCP reads. The old §6
“not in this PR” and F292's historical Host-owned credentials/intake/sourceGrant
are behavior history, not the current authority allocation. Operator deletion-first
source is `thread_mu8dg6h7l2x4ohsk#0001791597354169-000043-8e6a39d2`;
current terminal is `#0001791692969613-000094-97be6e64`, with C1 reminder096.
Task1843's accepted package continuation explicitly retains this redesign.

Before: find/download transcript, copy it to a thread and explain its provenance.
After: an authorized generated artifact has a durable plugin record; one ordinary
notification identifies it; a cat reads the exact recorded source through the
installed plugin MCP and the human supplies speaker/context/output judgment.
The human retains account authorization, source-read permission and destination
choice. No summarizer, household memory store, Needs Me producer or implicit
historical replay is added. C2 meeting cards remain outside package redesign.

## Source and concrete incompatibilities

Package starting source: clean `1a5d534b0890ce4cabfef9beef9caf06a2bbef11`;
meeting package remains alpha.10. It has no canonical YAML. Its manifest exposes
input-source/events.publish; entrypoint starts the broker handshake. Runtime source
normalization, bounded event/poll fallback, catch-up preview fingerprint and cursor
rules are reusable. The publication adapter and credential/source authority are not.

- `src/runtime.ts:flush` publishes the durable outbox head, then acknowledges it.
  `src/state-store.ts:acknowledge` removes the event. Once delivered, there is no
  persistent meeting index to serve the new MCP read. Outbox is not record custody.
- `src/artifact.ts:createFeishuTranscriptSourceAdapter` requires Host intakeId and
  sourceGrant. `src/gateway.ts:FeishuTranscriptGateway` explicitly assigns that lane
  to Host. Those cannot authorize reads after the specialized Host backend is removed.
- `src/lark-cli-gateway.ts` defaults to the process home; `lark-cli-runner.ts` gives
  the child HOME. Plugin ownership must not adopt operator-global credentials by
  choosing homedir. CLI credential isolation (including native keychain/backend),
  pinned binary acquisition and process-tree shutdown need executable evidence.
- The old resolver in Host `ca5b831b` supports minute and note transcript formats,
  2,000,000-byte text and temporary output cleanup. It does not prove exact revision
  parity: record reads must check the observed revision and honestly refuse stale
  or unavailable source, rather than labelling “latest” as the saved revision.

## Owner map and candidate lanes

Plugin owns account adapter, credential compartment, metadata index, source refs,
cursor, pending notification receipts and catch-up decision history. Source text
remains Feishu truth; any authorized local snapshot must retain its exact provenance
and no expiry by default. Host owns installation/digest/grants, user/thread/native
identity, module lifetime, target resolution and message dedupe. Source metadata
never supplies a Host user, thread or invocation identity.

Prefer the **existing** builtin module and declaration-activated stdio MCP carrier.
The MCP child follows W3's `createModuleActionClient` pattern: it receives only its
Host-issued action environment and runtime call metadata, then invokes the module's
private declared native methods. It gets neither the credential home nor direct
filesystem access to meeting records; no auxiliary listener, bearer config field,
Host callback meeting route or external stdio broker is added.

Candidate native methods: `meeting.records.list` (bounded metadata),
`meeting.records.read` (opaque record ID plus bounded text cursor). They require the
separate native context, current user/instance/grant and approved record/read scope
before and after asynchronous source work. A tool body cannot name another user,
record root, URL or target thread. Resource access through ordinary/HTTP/owner lanes
must fail closed. Final method/tool IDs, manifest grants and exact wire shape are
not frozen by this proposal.

Notifications use feature `messaging.send` and one Host-selected/granted destination,
not a source-selected target. Record and stable notification intent are persisted
before send; receipt is persisted after send. The 200-character MessageDraft key is
a fixed-length hash of instance + canonical source identity/revision + normalized
metadata + target + rendered body, not the older
signal key (which may exceed that limit). Response loss must reuse the exact target,
key and payload through Host dedupe; it must not create a second source record or
clear pending state on failure. Destination changes cannot silently retarget an
uncertain send. Revoke/disable fences ongoing reads and effects, and never erases
records or authorization history.

## Control lifecycle paired at Host150

Real current Host `InstalledPluginOperations.resolve` accepts only an installed,
**enabled + healthy** instance. Its commit fence repeats that condition; module
invocation resolves only an active module action table. Old Feishu device auth ran
before enable through special official-plugin routes. A direct mechanical migration
therefore cannot run its first connect action while the plugin is disabled.

An isolated executable probe calls the actual Host TypeScript service with an
in-memory disabled/stopped inventory: actual409, zero handler calls and zero config
writes. The proposed pre-enable journey's expected200 assertion fails. This is a
**candidate journey RED, not a defect in the current security guard** and not proof
of authenticated owner identity, installed resources or real device authorization.
Evidence and exact source hashes are in the linked receipt below.

Host150 (`thread_mrkn6povq4zzgh45#0001791696318597-000150-bb0e6c23`)
resolved the candidate incompatibility: normal explicit module enable starts only
the control plane. `start(host)` returns actions and stop without login, collection
or provider effects. Healthy means callable control module, not authenticated or
collecting. Keep disabled409 and the exact owner-operation third context, native
second context, lifecycle/currentness/grant fences. No pre-enable exception or new
setup/job API is introduced. Auth, persisted `collectionIntent` (default disabled),
and actual live collector are separate truths; successful login cannot enable
collection. Each collection/read/send entry must check current authorization.

The existing owner operation expires after 30 seconds or return. It cannot lend its
authority to a detached login process. Host160's source adjudication
(`thread_mrkn6povq4zzgh45#0001791696831186-000160-9de71aaf`) shows that
CLI1.0.85 cancellation does not bind the in-flight token POST, and credentials/profile
can be written before success output. Scope cache survives explicit cancellation;
cache/exit/stdout alone cannot establish not_started. Isolated HOME does not isolate
the Darwin OS Keychain master-key service. Before real login, prove a private
credential backend and identity-owned process-tree cleanup with controlled fixtures.
Restart or interruption remains unknown until a fresh owner reconciles existing
account/app/scope/attempt evidence; never blindly repeat token exchange. The corrected
source analysis does not justify a cross-request job or longer owner lifetime.

## Retained consumers: classify, do not recreate obsolete business

Frozen Host `ca5b831b` has ten intake routes: list/get, repair/clear, confirm, dismiss,
retry, presentation-retry, regrant and manual-import. It also has two catch-up routes,
one official history-import route, two official auth routes and one callback
meeting-artifact read route. These are sixteen explicit route dependencies across
four source files plus official auth, not just `/api/meeting-intakes`.

The old confirm/destination/sourceGrant/Needs Me semantics are not equivalent to the
new record/read/notification model. Package redesign does not recreate them or
create new cards. Host owner must classify the retained C2 calls as valid existing
neutral forwards or visible unavailable/retired states with exact status/response
checks. Generic handling cannot resurrect deleted F292 backend or source leases.
Historical records/data are not migrated, deleted, replayed or granted by this work.
The old callback read/tool must not remain a second successful resource authority.

## Implementation and proof units

1. **Lifecycle pairing:** consume this source-grounded RED; freeze control/source
   activation and owner-authorized setup/catch-up tuple with Host. Matrix includes
   never-authorized first install, verified login, expired/probe-failed auth,
   disable/restart/stop/timeout/revoke and late results. Host owner returns exact
   existing surface or amendment; package writer implements only that pairing.
2. **Owned record + notification core:** replace events publication with SDK send;
   append-only source/revision identity plus a durable outbox/receipt. Test discovery,
   overlap/redelivery, concurrent manual import, disk-full, crash before/after send,
   lost receipt, restart, target revocation and schema migration using isolated data.
   Cursor may advance only with record and notification intent durably committed.
   Fsync files/directories and CAS/fences are required at effect boundaries.
3. **Package-owned account/read adapter:** preserve bounded provider logic, move
   relevant source/auth behavior from exact pre-delete blobs with named semantic
   deltas. Prove isolated credential scope, fixed device domains, secret-free product
   projection, current auth before collection/read, bounded subprocess output,
   timeout/abort/process-tree cleanup, note/minute and revision/deletion failures.
4. **Installed MCP and Manager presentation:** canonical YAML and generated manifest,
   builtin module lifecycle, stdio MCP native client, generic auth/catch-up/status
   operations. Read-only status/list cannot start/replay/repair. Catch-up keeps the
   existing scanned fingerprint and explicit future-only/replay choice; owner
   tuple/currentness is checked before CAS and effect. No Needs Me or old broker fallback.
5. **Artifact and actual directory journey:** freeze a new local version and exact
   contract/SDK graph after source review; prove packed physical closure in an empty
   consumer, then actual Host directory-select/install/grant/auth/enable/discovery/
   notification/MCP/disable/restart. Archive green is not raw-directory green. Current
   alpha.10's dependency/resource exemption remains history; closure must use Host's
   reviewed materialization policy, without quota exceptions or registry substitutions.

Relevant existing commands: `pnpm --filter @clowder-ai/feishu-meeting-intake typecheck`,
`pnpm --filter @clowder-ai/feishu-meeting-intake test`,
`pnpm --filter @clowder-ai/feishu-meeting-intake build`,
`pnpm test:train-c1-inventory`, `git diff --check`.
Full operator acceptance/soak/release/C1 remain open.

## Reviewed record foundation (historical checkpoint)

`src/record-delivery.ts` retains metadata and canonical source/revision after delivery.
It uses a Host-provided private instance directory, 16KiB regular private record
files, fsync plus atomic rename, bounded-page memory and no TTL/delete operation.
Before entering an injected SDK-compatible sender it durably marks `unknown`; an
explicit fresh retry reuses the exact stored thread/key/body. A matching receipt is
committed only after currentness is checked again. The stable key hashes JSON-framed
opaque instance identity, canonical source handle, metadata, target and rendered body,
preserving Unicode identity.
Concurrent reopened handles serialize within one process. Source metadata cannot
retarget the notification or replace Host identity.

Review171 exposed two real test blind spots: mutable persisted intent could certify
itself, and a provider title could introduce template lines. The v2 storage envelope
now separates immutable intent from mutable settlement. A private independently
stored 32-byte integrity key authenticates the complete intent with HMAC-SHA256;
another domain authenticates state/receipt together with that intent tag. Recovery
verifies both bindings before interpreting the projection. The key is published
exclusively as a read-only 0400 file after file fsync, then directory fsync; records
are not committed before it. Target, body, source metadata, public key and settlement
cannot be rewritten or transplanted while retaining valid bindings.

The integrity key must be retained with the records. Missing/malformed keys and
unbound legacy records fail closed as recovery required; they are never silently
resealed, migrated or deleted. These bindings do not prevent rollback of a previously
authentic snapshot or compromise of the private directory and key. They do not grant
authorization, establish provider truth or replace current destination/grant checks.
The eventual caller must enforce those checks when recovering a send.

Provider titles remain original source metadata in the record. Notification text
cleans control/Unicode line separators and bidirectional formatting, bounds the title
to 512 characters and JSON-encodes it on one explicitly untrusted data line. No raw
provider title can add a SYSTEM, mention or tool-command template line; this framing
does not claim that a model cannot misinterpret quoted data.

At that historical review checkpoint this module had no activated caller or public root export. The current builtin module now calls it; the core still is not exported from the public root.
Its scope object is an internal fence supplied by the eventual module caller, not
new authority. Reads require that caller's authorization; each sender call requires
current target/grants through the SDK/Host. The Host owns the single active writer
and private directory; no cross-process lock or hostile ancestor-directory custody
is claimed. Keyset pages are live, not a snapshot; page memory is bounded while
directory scan cost still grows with retained record count.

Source tests exercise retention, loss of send response, immutable intent, restart,
same-process overlap, revocation before commit/after acceptance, hostile persisted
bytes/symlinks, receipt mismatch, bounded pages and opaque identifiers. These are
injected-sender/isolated filesystem proofs, not authenticated Host sends, full disk
failure, source cursor+record atomicity, process shutdown, login, MCP or installation.
Legacy broker/runtime library functions remain as compatibility history. The current alpha.11 production manifest selects builtin/MCP and removes events.publish; its adapter requires the existing SDK20/contract36 module ABI. Current verification and actual Host installation remain open. The old checkpoint was a source-review boundary, not completion of the redesign.

Architecture cell: plugin. Map delta: candidate authority inversion from historical
F292 Host source/intake custody to package record/read custody; requires exact Host
pairing before contract changes. Why: the accepted C1 overview cancels specialized
Needs Me/intake/source-grant integration while preserving ordinary notification and
source-bound authorized reading. No new operator value decision is needed.

[Probe, observation and source-binding receipt](</Users/lang/workspace/github-lab/f202-handoff/meeting-redesign-2026-10-11/source-receipt.json>)
