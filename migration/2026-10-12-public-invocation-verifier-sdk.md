---
feature_ids: [F202]
topics: [plugins, sdk, public-invocation, host-pairing]
doc_kind: implementation-handoff
created: 2026-10-12
---

# Preserve the existing private Host verifier activation slot

Accepted original Task1843/401/422 boundary and Host1330 (`thread_mu8dg6h7l2x4ohsk` via owner message `0001791849219567-001330-d607605b`), directly checked against Host `846b88ac0fdccc96a82d62e87391eefb35ef52c3` public-invocation-verifier and carrier sources. No speculative source/admit export is added.

The feature activation own data-function `publicInvocationVerifier` was previously discarded by both Feature and module normalization. It now survives FeatureActivation → activateDefinedFeature → startDefinedPluginModule → PluginModuleActivationShape. Absent old activators remain absent. Inherited/accessor/non-function slots refuse before use; multiple supplied feature slots refuse rather than select a last writer. The reserved `host.public-invocation.assert-current` cannot be an ordinary action or MCP method.

Only the existing input is mirrored: authority ref and **opaque string** revision; `message:<id>` source pointer; target Cat; native contribution and sorted unique declared methods. SDK captures detached frozen data before the first awaited Host check and passes only `signal/assertCurrent`. The actual Host owns instance/digest/lifecycle/grants/declaration/authority and isolated ALS. SDK adds its feature stop fence and preserves Host/business refusal without retry. Results require exactly `{current:true}`, never fabricated verification success. Abort/stop refuses pending/late delivery; escaped invocation fences expire after return.

The SDK has no Collective verifier business, new capability, public native declaration, Queue settlement index/worker, private Task authorization or source-reader fallback. Existing Collective native9 remain unregistered, verifyAgent remains false, and entry/pair/reconciler remain staged. Source/admit adapter delivery and queued exact-child reader correction are still Host responsibilities. Isolated private verification cannot use ordinary owner/native `sourceFacts/nativeContext` as a workaround.

Validation binds this SDK delta and a packed empty consumer under injected Host ABI only; it does not inherit old258 cloud/Host installation receipts or prove a public execution journey. Keep existing unpublished SDK20 identity only while the exact registry identity remains absent; do not alter plugin pins, historical archives, root lock, catalog or Collective business.
