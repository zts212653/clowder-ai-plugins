---
feature_ids: [F202]
topics: [collective, public-source, native, migration]
doc_kind: implementation
created: 2026-10-13
---

Before: the legacy Host dispatcher stores the Collective source and enqueues one Cat itself.
After: the package preserves the Service event, sends its visible source through Host messaging without wake,
commits the exact source correlation in its existing inbox, and asks the existing Host Queue to admit one declared target.

This is the ordinary exact-agent source portion of original Task1843/401/422. It pairs the delivered
Host `sourceFacts/nativeContext` and `publicInvocations.enqueue` ABI with existing package business custody.
It does not register a production entrypoint or add a native declaration before their handlers are paired.

## Ownership and actual call order

The package owns the existing Service/Connector inbox, per-Cat participation scope, endpoint credential,
source correlation, and business permission revalidation. Host owns installation/lifetime/grants, authenticated
owner/native identity, persistent Message, declared MCP methods, target participation, and Queue custody.
The original `collective-ingress-routing.ts` is moved byte for byte in the mechanical commit, then adapted
only at imports and its source type. Metadata, sender, idempotency, attention selection and error helpers retain their original algorithms.

`createCollectivePublicSourceCaller` requires real Host ports and the module's fixed native contribution.
`admitAgentEvent(connectionId, eventId, ownerContext)` accepts its owner identity only from the separate
Host `PluginOwnerOperationContext`; these fields are never native tool body inputs.

1. Read the retained inbox event; require an ordinary exact agent recipient and current Service participation.
   Preserve the original local-echo preflight: a same-connection Agent event without a Work acceptance/execution
   notice returns `local_echo` before the routing attempt, Host Message or Queue admission. The persistent
   binding reader/writer rejects that same event, so retained echo cannot become an executable source.
2. Check the strict owner thread and target membership. Begin the existing inbox routing attempt.
3. Revalidate Service permission and the materialized destination after asynchronous checks, then
   `messaging.send` with the original metadata, sender and idempotency key, `identity: collective`, observation provenance, and **no wake**.
4. Atomically record `publicSource` on that same inbox item before `enqueue`. The original schema version 3
   gains one optional field with no default; old records retain their serialized shape.
5. Revalidate Service and the stored binding; enqueue with its opaque business ref/revision and sorted declared methods.
   Return the Host receipt as Queue custody, never business delivery or private Work authority.

The binding is detached, unique per message, and cannot be replaced by a different instance, message,
owner, destination or native method set. The existing persistence writer tail serializes initialization.
Routing retry preserves the field. An exact source remains usable through unrelated roster changes;
removal/re-addition, destination drift, endpoint revocation, or Service refusal denies it.

## Verifier and native consumer

The private activation `publicInvocationVerifier` has exactly the delivered `signal/assertCurrent` context.
It resolves only the package's private inbox mapping and rechecks the Service. It compares the full
authority/source/target/native tuple. It never calls an ALS-bound Host source port or returns unconditional true.
Its ref/revision is an opaque business correlation, not a Host Task receipt, purpose winner, or launch grant.

`resolveNative(actionContext, fixedActionMethod)` reads authenticated `nativeContext.current()` and compares
the separate Host action identity, exact origin, source owner/thread/cat-null/content, plugin instance,
Collective participation metadata, and allowed fixed method against that durable binding. It rechecks
Service permission and native currentness and returns a `revalidate` operation for checks before and after
each original native business mutation/reply. No tool body selects invocation identity.

Lost admission responses retain the real source and binding; an explicit same-source retry reuses the
Host idempotency key and mapping. Stop/late results reject without claiming rollback of committed Host effects.
No worker, Queue settlement index, new protocol, Host signing port, or callback secret is introduced.

## Remaining original consumers

Channel listener/response-request selection is still paired separately using its original algorithm.
Work entrust/revision/execution notices cannot enter this ordinary consumer. Reconsideration still needs
the original purpose winner, original source and Service permission. Private Work still needs its writable
workspace/effect guard, exact owner receipt/delegation and producer-bound artifact seam. None is replaced by
public enqueue or this mapping. The nine native handlers, entry/pair/reconciler and actual event pump remain
unregistered until their full dependency chain is ready; current production `verifyAgent=false` stays honest.

Targeted tests use real persistent Connector and Service business with owned ephemeral listeners and explicit
Host transport/auth fixtures. They prove this source/custody/revalidation portion, not actual Host installed
native execution, owner authentication, or C1 completion. Existing isolated installed-directory lifecycle
evidence is also fixture-bound. Real Manager installation remains with the Host responsibility chain.
