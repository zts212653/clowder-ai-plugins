---
feature_ids: [F202]
topics: [collective, native, installation, entrypoint]
doc_kind: implementation-handoff
created: 2026-10-13
---

# Production ordinary native entry

The original C1 target is installation followed by the original Collective and meeting functionality.
This change registers four existing ordinary consumers in the actual module; it does not close C1.
No withdrawn private-execution design is a dependency. The remaining Work/reconsideration/native
consumers and complete retained participation page remain implementation work in Task1843.

The module now owns one `collective-native` stdio MCP contribution with four actions:

| Tool | Module action | Input |
|---|---|---|
| cat_cafe_collective_current_context | collective.context.current | {} |
| cat_cafe_collective_read_context | collective.context.read | contextRef, optional afterSequence/limit |
| cat_cafe_collective_set_interest | collective.participation.set-interest | contextRef, state=listen/withdraw |
| cat_cafe_collective_submit_reply | collective.reply.submit | returnRef, replyOperationRef, body |

The MCP client forwards runtime metadata separately. The native second context supplies user, Cat,
thread and invocation. The original Connector Agent check now reads the Host native context and
matches Cat and invocation/sessionRef; browser and body identity cannot supply that check.
The module activates the existing private source verifier and instance-bound persistent references.
It keeps original Service permission/currentness and reply outbox idempotency, rather than treating
Queue custody as business completion. No ordinary method exposes the verifier or callback secret.

Existing owner webhook calls `entry-roster`, `pair` and `connections/:connectionId/participation/reconcile`
now reach the previously reviewed roster, pairing and reconciliation wrappers. Their existing schemas,
origin/fingerprint/exclusion checks and owner thread/participation algorithms remain.
Reconciliation keeps the original per-connection owner mutation serialization and checks lifecycle
before continuing thread/route/publication effects.

## Installation and operation

1. Select this checkout's `packages/collective-connector` directory in Manager; authorize its declared
   data.directory, thread.readContent, thread.listMetadata, thread.write and messaging.send capabilities;
   enable the builtin module. The exact directory and dependency graph are bound in the source-ready
   evidence supplied with the reviewed commit. No npm publication is needed.
2. Use the existing Collective launch/onboarding and pair intent. The retained entry review calls
   GET `/api/plugins/official.collective-connector/entry-roster`; confirming calls POST `.../pair` with
   the original serviceUrl/endpointLabel/intent/rosterFingerprint/excludedCatIds shape.
3. Materialize authorized channels through POST `.../connections/:connectionId/participation/reconcile`
   with `{expectedRevision,channelIds}`. The remaining full participation page is not claimed ready
   by this change; it must be restored by the package writer to complete the original UI journey.
4. Settings → Collective participation → Paired connections displays current owner-bound connection
   rows. Select Sync on that row. The existing owner action route is
   POST `/api/plugins/official.collective-connector/actions/participation/sync`, body
   `{connectionId}`. It syncs Service and persists exact named ordinary requests, then admits
   each named Cat through Host Queue. The returned rows distinguish Queue custody and sources still
   pending their original Work/channel consumer. No worker/index/protocol is added.
5. The authenticated native invocation calls current context, optionally bounded read/interest, then
   submits the reply using the returned references. The original reply is published by the package's
   Connector outbox to Collective; Host stream output does not replace it.
6. Disable/re-enable preserves business state and reference secret; stopped handlers and verifier refuse.

## Concrete Host pairing gap

The current Host `755524d481` ownerThreads.get only recognizes authenticated owner webhook context.
The existing Settings owner-operation context is independently trusted but is refused there. A probe
of the actual Host function under withCurrentOwnerOperation reproduces DELIVERY_REJECTED before
store access; the source caller's check is retained. Astra has independently reviewed and committed the concrete adjustment as
`1e3f21cf886e2a6e235ae93a57fc6315ab8203a6` (27/27 and build). Its ABI is unchanged.
The actual API is still `755524d481` pending the Host-owned restart; real installation and
use consume that newer Host commit. The package does not loosen its existing check.

## Evidence boundaries

Real Service/Connector fixture enters through the actual module and exercises owner row operation,
persistent source, private verifier, Queue admission and original reply. The empty npm consumer runs
the actual MCP process and lists its four strict schemas, imports the runtime closure, and executes
bootstrap/create/disable/re-enable. These prove production registration and physical runtime closure;
Host identity/Queue parts of the module journey are explicit fixtures. Actual installed native use,
private Work, remaining UI/consumer work, meeting migration and whole-C1 acceptance are not proved.
