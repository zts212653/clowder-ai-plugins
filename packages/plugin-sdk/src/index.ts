/**
 * Public SDK entrypoint.
 *
 * This package exposes:
 *   1. Schema-neutral NDJSON transport (stdio-runtime, S0/#12)
 *   2. Wire dispatch classifier (wire-dispatch, S1)
 *
 * The beta.8 handshake, beta.9 events.publish, beta.10 lifecycle, and beta.11
 * messaging rows are executable. beta.9 adds the Train B author facade around
 * Host-issued feature bindings without widening the frozen M0 wire registry.
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
  type StandaloneMessageHandler,
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

export {
  classifyFrame,
  type DispatchResult,
  type InFlightEntry,
  type RequestSnapshot,
} from './wire-dispatch.js';

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
  ContributionConflictError,
  FeatureContextRevokedError,
  createFeatureContextSession,
  definePlugin,
  type ContributionRegistration,
  type ContributionRegistrar,
  type DefinedPlugin,
  type FeatureActivator,
  type FeatureBinding,
  type FeatureContext,
  type FeatureContextSession,
  type FeatureHostAdapter,
  type HostContributionReceipt,
  type PluginDefinitionInput,
} from './feature-context.js';
