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
export type { CollectiveArtifactOwnerPort, CollectiveArtifactOwnerResult, CollectiveArtifactCustodyTransferPort,
  CollectiveArtifactMediaReadPort, CollectiveArtifactMediaResult } from './collective-artifact-owner.js';
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
  type StandaloneDeliveryHandler,
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
export type { PluginMessage } from './message-read.js';
export type {
  DispatchResult,
  InFlightEntry,
  RequestSnapshot,
} from '@clowder-ai/plugin-contract';


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
  PresentationDeliveryInputError,
  isDeliveryPresentationContext,
  isMediaUnavailableMessageElement,
  isMediaWarningMessageElement,
  requireDeliveryPresentation,
} from './p1-runtime.js';

export {
  HostBoundSessionError,
  createHostBoundSession,
  type HostBoundSession,
  type HostBoundSessionOptions,
  type HostBoundDeliveryHandler,
} from './host-bound-session.js';

export {
  FeatureContextRevokedError,
  FeaturePermissionError,
  activateDefinedFeature,
  createFeatureContextSession,
  definePlugin,
  type ActivePluginFeature,
  type DefinedPlugin,
  type FeatureActivation,
  type FeatureActivator,
  type FeatureBinding,
  type FeatureContext,
  type FeatureContextSession,
  type FeatureContextSessionOptions,
  type FeatureHostAdapter,
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
  ModulePluginSettingsHost,
  ModulePluginLogLevel,
  PluginMessageContent,
  PluginMessagingDelivery,
  PluginMessagingDraft,
  PluginMessagingHost,
  PluginMessagingSubscribeOptions,
  PluginModuleActivationShape,
  PluginStorageCompareAndSetResult,
  PluginStorageDeleteResult,
  PluginStorageEntry,
  PluginStorageHost,
  PluginTaskCreateInput,
  PluginTaskWorkTime,
  PluginTaskWorkData,
  PluginTaskWorkMutation,
  PluginTaskHost,
  PluginTaskHostAdapter,
  PluginTaskSelector,
  PluginTaskFilter,
  PluginTaskCreateOptions,
  PluginTaskUpdateConditions,
  PluginTaskItem,
  PluginTaskReadItem,
  PluginTaskEntrustedWorkSummary,
  PluginTaskWait,
  PluginWaitUpdate,
  PluginTaskKind,
  PluginTaskStatus,
  PluginTaskUpdateInput,
  PluginThreadHost,
  PluginThreadCreateInput,
  PluginThreadMessage,
  PluginThreadCat,
  PluginThreadCats,
  PluginThreadSummary,
} from './module-host.js';
export type {
  PluginTaskDataControllerBinding,
  PluginTaskDataControllerBindInput,
  PluginTaskDataControllerMutationResult,
  PluginTaskDataControllerRevokeInput,
  PluginTaskDataControllerSummary,
} from './task-data-controller.js';

export {
  ConnectorOutboundDeliveryError,
  requireConnectorOutboundDelivery,
  type ConnectorCardAction,
  type ConnectorOutboundDelivery,
  type ConnectorOutboundMedia,
  type ConnectorPresentation,
} from './connector-runtime.js';

export { createConnectorCommandBridge } from './connector-command-bridge.js';

export { createModuleActionClient, type ModuleActionCallOptions,
  type ModuleActionClientOptions, type PluginActionContext } from './module-action-client.js';




export * from './host-action-context.js';
export type { PluginRuntimeInfo, PluginRuntimeInfoHost, PluginUiPanel } from './runtime-info.js';

export * from './members.js';


export { createStreamsClient, type PluginStreams, type PluginStreamReadOptions } from './streams.js';
export type { PluginStopContext, PluginPreStopContext } from './module-host.js';

export * from './delivery.js';
