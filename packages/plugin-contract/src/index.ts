/**
 * @clowder-ai/plugin-contract
 *
 * The single machine-readable truth source for the Clowder AI plugin
 * ecosystem (P15).  Schema, types, capability table, and conformance
 * utilities all ship from this package — the host (clowder-ai) and
 * plugin SDK both consume it; neither redefines structures.
 *
 * ## Version strategy (pre-1.0)
 *
 * - `0.x.0-candidate.N`: work-in-progress, NOT published to registry,
 *   no implementation may consume.
 * - `0.x.0`: published after dual-sign merge (CODEOWNERS) + CI publish.
 *   Registry must show exact version + digest before any gate proceeds.
 * - Breaking changes are expected before 1.0 (P3).
 * - v1.0.0 = public compatibility commitment; breaking window closes.
 *
 * ## Domains (v0.1 candidate)
 *
 * - **messaging**: MessagePayload, MessageDraft, MessageEnvelope,
 *   MessageOutputEvent, AppendElementsRequest, SendReceipt
 * - **manifest**: PluginManifest, PluginFeature, DataDeclaration,
 *   RuntimeDeclaration (v0.1 scope — signals/tasks/windows deferred)
 * - **capability**: L0/L1/L2 capability table (candidate until co-signed)
 * - **data-class**: DataClass × DataStrategy validation
 * - **common**: Actor, Provenance, ThreadHandle, ConnectorBindingRef,
 *   MessageHandle, SubscriptionCursor, IngressSourceAddress
 *
 * @packageDocumentation
 */

// Re-export everything from the types barrel
export * from './types/index.js';

// Re-export conformance utilities
export {
  isValidDataClassStrategy,
  DATA_CLASS_ALLOWED_STRATEGIES,
  CAPABILITY_TABLE,
  getCapabilityLayer,
  L0_CAPABILITIES,
  L1_CAPABILITIES,
  L2_CAPABILITIES,
} from './conformance/index.js';
