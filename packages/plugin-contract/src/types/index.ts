/**
 * Type re-exports for @clowder-ai/plugin-contract.
 *
 * @packageDocumentation
 */

// Common primitives
export type {
  Actor,
  ActorKind,
  AppendIdempotencyScope,
  ConnectorBindingRef,
  DraftAddress,
  EpistemicStatus,
  IngressSourceAddress,
  MessageHandle,
  Provenance,
  SendIdempotencyScope,
  SubscriptionCursor,
  ThreadHandle,
} from './common.js';

// Messaging domain
export type {
  AppendElementsRequest,
  CanonicalAudience,
  DraftAudience,
  MessageDraft,
  MessageElement,
  MessageElementsAppendEvent,
  MessageEnvelope,
  MessageOutputEvent,
  MessagePayload,
  MessagePublishEvent,
  SendReceipt,
  SubscriptionDelivery,
} from './messaging.js';

// Manifest (v0.1 scope — signals/tasks/windows deferred to C-2/C-3)
export type {
  PluginFeature,
  PluginManifest,
  ResourceReference,
  RuntimeDeclaration,
  RuntimeTransport,
} from './manifest.js';

// Data classification
export type {
  DataClass,
  DataDeclaration,
  DataStrategy,
} from './data-class.js';
export {
  DATA_CLASS_ALLOWED_STRATEGIES,
  isValidDataClassStrategy,
} from './data-class.js';

// Capability table
export type {
  AuthorizationLayer,
  Capability,
  L0Capability,
  L1Capability,
  L2Capability,
} from './capability.js';
export {
  CAPABILITY_TABLE,
  getCapabilityLayer,
  L0_CAPABILITIES,
  L1_CAPABILITIES,
  L2_CAPABILITIES,
} from './capability.js';
