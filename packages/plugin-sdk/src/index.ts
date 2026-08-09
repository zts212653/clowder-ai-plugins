/**
 * Public SDK entrypoint.
 *
 * This package exposes:
 *   1. Schema-neutral NDJSON transport (stdio-runtime, S0/#12)
 *   2. Wire dispatch classifier (wire-dispatch, S1)
 *
 * The beta.8 handshake rows and beta.9 events.publish row are executable;
 * remaining production RPC methods stay reserved. The dispatch
 * classifier gates all methods: CLOSED rows validate input shapes, RESERVED
 * rows fail-closed with T-G (input type is `never` in v0 — no legal params
 * exist).
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
