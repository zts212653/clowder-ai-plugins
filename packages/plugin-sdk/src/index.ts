/**
 * Public SDK entrypoint.
 *
 * This package exposes:
 *   1. Schema-neutral NDJSON transport (stdio-runtime, S0/#12)
 *   2. Wire dispatch classifier (classifyFrame, re-exported from
 *      @clowder-ai/plugin-contract where the classifier now lives, F202 C1)
 *
 * The beta.8 handshake, beta.9 events.publish, beta.10 lifecycle, and beta.11
 * messaging rows are executable. SDK beta.10 adds the content editor provider
 * registrar to the Train B author facade without widening the frozen M0 wire registry.
 * SDK beta.11 adds the desktop window registrar and the browser-safe /companion client.
 * The dispatch classifier gates every method before standalone callbacks or
 * Host-bound transport behavior can run.
 */
export {
  NdjsonFrameError,
  StdioRuntimeFatalError,
  createStdioChannel,
  startStdioRuntime,
  type StdioChannel,
  type StdioChannelOptions,
  type JsonObject,
  type StdioFrame,
  type StdioFrameErrorCode,
  type StdioFrameHandler,
  type StdioRuntimeFatalReason,
  type StdioRuntimeFatalErrorOptions,
  type StdioRuntimeOptions,
} from './stdio-runtime.js';

export {
  loadStandaloneManifest,
  ManifestStartupError,
  startStandaloneHost,
  type StandaloneHost,
  type StandaloneHostOptions,
  type StandaloneMessageDisposition,
  type StandaloneLifecycleDisposition,
  type StandaloneMessageHandler,
  type StandaloneLifecycleHandler,
} from './standalone-host.js';

export {
  acceptSessionBinding,
  beginLocalHandshake,
  prepareActivation,
  type ActivatedHandshakeState,
  type ActivationHandshakeIntent,
  type BindingHandshakeIntent,
  type BoundHandshakeState,
  type CandidateHandshakeIntent,
  type CandidateHandshakeState,
  type HandshakePhase,
  type HandshakeValidationLevels,
  type LocalHandshakeIntent,
  type LocalHandshakeState,
  type LocalHandshakeTransition,
  type RejectedHandshakeState,
} from './handshake-client.js';

export { classifyFrame } from '@clowder-ai/plugin-contract';
export type {
  DispatchResult,
  InFlightEntry,
  RequestSnapshot,
} from '@clowder-ai/plugin-contract';

export {
  EventsPublishError,
  createEventsPublisher,
  type EventsPublishErrorCode,
  type EventsPublishHostTransport,
  type StdioSessionLiveness,
  type EventsPublisherOptions,
  type EventsPublisher,
} from './events-publisher.js';

export {
  MessagingClientError,
  createMessagingClient,
  type MessagingClient,
  type MessagingClientErrorCode,
  type MessagingClientOptions,
  type MessagingHostTransport,
  type OutboundMessagingMethod,
} from './messaging-client.js';

export {
  LifecycleActionInputError,
  MediaReadProtocolError,
  MediaSourceActionInputError,
  PresentationDeliveryInputError,
  createMediaReader,
  decideLifecycleTransition,
  lifecycleRejectReason,
  defineMediaSourceReadAction,
  defineMediaSourceSettleAction,
  defineLifecycleAction,
  isDeliveryPresentationContext,
  isMediaUnavailableMessageElement,
  isMediaWarningMessageElement,
  requireDeliveryPresentation,
  requireLifecycleInput,
  type LifecycleAction,
  type LifecycleTransitionDecision,
  type LifecycleTransitionRejectReason,
  type MediaChunkReader,
  type MediaSourceReadAction,
  type MediaSourceSettleAction,
  type PluginMediaReader,
} from './p1-runtime.js';

export type {
  MediaSourceReadChunkResult,
  MediaSourceReadInput,
  MediaSourceReadRejectedResult,
  MediaSourceReadResult,
  MediaSourceSettleInput,
} from '@clowder-ai/plugin-contract';

export {
  HostBoundSessionError,
  createHostBoundSession,
  type HostBoundMessageDisposition,
  type HostBoundLifecycleDisposition,
  type HostBoundMessageHandler,
  type HostBoundLifecycleHandler,
  type HostBoundEventPublishingOptions,
  type HostBoundSession,
  type HostBoundSessionOptions,
} from './host-bound-session.js';

export {
  ContributionConflictError,
  FeatureContextRevokedError,
  FeaturePermissionError,
  activateDefinedFeature,
  createFeatureContextSession,
  definePlugin,
  type ActivePluginFeature,
  type ActivePluginFeatureOptions,
  type ContributionRegistration,
  type ContributionRegistrar,
  type DefinedPlugin,
  type FeatureActivation,
  type FeatureActivator,
  type FeatureBinding,
  type FeatureContext,
  type FeatureContextSession,
  type FeatureContextSessionOptions,
  type FeatureHostAdapter,
  type HostContributionReceipt,
  type PluginActionHandler,
  type PluginDefinitionInput,
  type PluginLogLevel,
} from './feature-context.js';

export {
  operationRowAction,
  rowsResult,
  type OperationRowActionOptions,
  type RowsResultOptions,
} from './operation-results.js';

export {
  PluginModuleEntrypointError,
  definePluginModule,
  requirePluginModuleEntrypoint,
  type PluginModuleDefinition,
  type PluginModuleEntrypoint,
} from './module-plugin.js';

export type {
  ModulePluginHostShape,
  ModulePluginLogLevel,
  PluginMessageContent,
  PluginMessagingDelivery,
  PluginMessagingDraft,
  PluginMessagingHost,
  PluginMessagingSubscribeOptions,
  PluginMediaHost,
  PluginModuleActivationShape,
  PluginStorageCompareAndSetResult,
  PluginStorageDeleteResult,
  PluginStorageEntry,
  PluginStorageHost,
  PluginTaskCreateInput,
  PluginTaskHost,
  PluginTaskItem,
  PluginTaskKind,
  PluginTaskStatus,
  PluginTaskUpdateInput,
  PluginThreadBindingSummary,
  PluginThreadHost,
  PluginThreadSummary,
} from './module-host.js';

export {
  ConnectorOutboundDeliveryError,
  requireConnectorOutboundDelivery,
  type ConnectorCardAction,
  type ConnectorOutboundDelivery,
  type ConnectorOutboundMedia,
  type ConnectorPresentation,
} from './connector-runtime.js';
