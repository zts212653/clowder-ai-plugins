---
feature_ids: [F202]
topics: [plugin-sdk, source-facts, native-context]
doc_kind: implementation-note
created: 2026-10-12
---

# Exact source subset mirror

Original Task1843 and accepted source `thread_mu8dg6h7l2x4ohsk#0001791692969613-000094-97be6e64` retain the package/SDK/contract writer responsibility. Host delivery `thread_mrkn6povq4zzgh45#0001791812774216-000830-d524482a` implements one subset of the original401/422 seam at Host `f8313f3c12071d9396445d6cfb0e5d212cbdd92d` / TREE `e63c31d6b91e0f483327bd798712c5bd8d9b7335`.

The SDK mirrors optional `sourceFacts.read({ messageRef: message:<id> })` and `nativeContext.current()`. Public DTOs come from the contract schema; the SDK read signature narrows the generated input string to the Host's `message:${string}` template. Both facades require the existing `thread.readContent` feature grant before and after the awaited Host call, preserve Host rejection, and refuse results after stop. A missing older carrier port stays absent; an incomplete supplied port fails closed. No retry or generic thread fallback is supplied.

Host owns authentication, source lifetime, owner/instance and exact-origin authorization. The owner lane can read only same-instance plugin sources in owner-created threads. Native reads can only use the authenticated invocation's exact origin. The current() method takes no body; its source is the complete public fact, not an adopted-hold pointer. Source facts do not establish public invocation authority or provider support.

Fact fields are exactly id/userId/threadId/catId(nullable)/content/source.connector/source.meta(optional JSON)/extra.pluginMessage.instanceId. Native context fields are userId/threadId/catId/invocationId/originTriggerMessageId/source. The DTO boundary excludes additional private fields, non-JSON values, accessors, symbols, sparse arrays and nested data beyond the Host's 32-level source snapshot allowance. The native identity wrapper does not consume a source nesting level. All returned data is detached and deeply frozen.

No Task-bound receipt/ancestor access or private Work binding is implemented in this Host slice. Those capabilities remain absent, and package Service/participation rules remain package-owned. Collective's manifest, active entrypoint and staged business callers are unchanged. No MCP contribution or new capability is added.

## Evidence and limits

The exact eight Host commit blob hashes are bound by the shared `source-facts-host-mirror-binding.json`. Missing DTO/module ports reproduced RED, followed by 12/12 targeted GREEN; a separate valid-depth native wrapper RED/GREEN preserves the actual Host allowance. The initial test fixture omitted its builtin entrypoint; that setup failure is separately retained and is not business RED.

`verify-source-facts-sdk.py` completed all12 affected commands: contract generator/types/regression, SDK regression/types, packed empty-consumer journey, Collective types/regression/build/source and TrainC1 inventory/diff. The packed journey exercises the real installed SDK module/facades with injected Host ports. It does not prove real authenticated owner/native ALS, Work/source admission, provider support, actual Collective installed acceptance or C1 completion.

Contract36/SDK20 returned exact registry E404 before packing; no version, dependency pin, shrinkwrap, root lock or historical archive is changed. New candidate artifacts stay in their own shared `source-facts-packed-artifacts` directory. Old source-ready/packed/page receipts are historical and are not rebound to the changed SDK/contract bytes.

Architecture cell: existing plugin contract/SDK Host facade. Map delta: none; Host source authorization stays Host-owned, and the SDK only validates and fences the published carrier. Tips exempt: this is a developer-facing optional mirror with no newly registered owner/native action or Settings journey. No stores, jobs, background reads, writes or product authority are introduced.
