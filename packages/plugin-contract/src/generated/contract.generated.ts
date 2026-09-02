/**
 * Generated from plugin-metadata.schema.json, manifest.schema.json, catalog.schema.json, signal.schema.json, messaging.schema.json, physical-limb.schema.json, and behavior-fixture.schema.json.
 * Do not edit by hand. Run `pnpm generate` after changing a schema.
 */

export type LocalizedDescriptionObject = {
  readonly default: string;
  readonly translations: Readonly<Record<string, string>>;
};
export type LocalizedDescription = string | LocalizedDescriptionObject;
export type PackageAssetPath = string;
export type PackageIcon = {
  readonly type: 'svg';
  readonly src: PackageAssetPath & `${string}.svg`;
} | {
  readonly type: 'png';
  readonly src: PackageAssetPath & `${string}.png`;
};
export type PluginIcon = 'github' | PackageIcon;

export type SemVer = string;
export type DataClass = 'cache' | 'ephemeral' | 'user-authored' | 'derived-user-visible' | 'relationship' | 'interaction-history';
export type DataStrategy = 'lifecycle' | 'retained' | 'ask-on-uninstall';
export type Capability = 'plugin.config.read' | 'plugin.state.get' | 'plugin.state.set' | 'messaging.send' | 'schedule.register' | 'events.publish' | 'messaging.appendElements' | 'onMessage' | 'message.event.subscribe' | 'secret.read' | 'thread.listMetadata' | 'thread.readContent' | 'memory.query' | 'memory.append' | 'memory.retrieve' | 'windows.create' | 'whisper.extend';
export type DataDeclaration = {
  readonly name: string;
  readonly dataClass: 'cache';
  readonly strategy: 'lifecycle' | 'retained' | 'ask-on-uninstall';
  readonly schemaVersion?: string;
} | {
  readonly name: string;
  readonly dataClass: 'ephemeral';
  readonly strategy: 'lifecycle' | 'retained' | 'ask-on-uninstall';
  readonly schemaVersion?: string;
} | {
  readonly name: string;
  readonly dataClass: 'user-authored';
  readonly strategy: 'retained' | 'ask-on-uninstall';
  readonly schemaVersion?: string;
} | {
  readonly name: string;
  readonly dataClass: 'derived-user-visible';
  readonly strategy: 'retained' | 'ask-on-uninstall';
  readonly schemaVersion?: string;
} | {
  readonly name: string;
  readonly dataClass: 'relationship';
  readonly strategy: 'retained' | 'ask-on-uninstall';
  readonly schemaVersion?: string;
} | {
  readonly name: string;
  readonly dataClass: 'interaction-history';
  readonly strategy: 'retained' | 'ask-on-uninstall';
  readonly schemaVersion?: string;
};
export type ResourceReference = {
  readonly type: string;
  readonly id: string;
};
export type ContributionReference = {
  readonly type: 'identity' | 'schedule' | 'tool' | 'mcp' | 'skill' | 'limb' | 'webhook' | 'message-subscription' | 'service' | 'connector' | 'ui';
  readonly id: string;
};
export type PackageRelativePath = string;
export type ConfigurationOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly docsUrl?: string;
};
export type ConfigurationField = {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'string';
  readonly required: boolean;
  readonly default?: string;
  readonly options?: never;
} | {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'secret';
  readonly required: boolean;
  readonly default?: never;
  readonly options?: never;
} | {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'select';
  readonly required: boolean;
  readonly default?: string;
  readonly options: readonly ConfigurationOption[];
} | {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'boolean';
  readonly required: boolean;
  readonly default?: boolean;
  readonly options?: never;
} | {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'number';
  readonly required: boolean;
  readonly default?: number;
  readonly options?: never;
} | {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: 'url';
  readonly required: boolean;
  readonly default?: string;
  readonly options?: never;
};
export type EnvironmentBinding = {
  readonly source: 'config';
  readonly key: string;
} | {
  readonly source: 'secret';
  readonly key: string;
};
export type ContributionRuntime = {
  readonly transport: 'stdio' | 'ipc';
  readonly entrypoint: PackageRelativePath;
  readonly args?: readonly string[];
};
export type CallbackAction = {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
};
export type IdentityContribution = {
  readonly type: 'identity';
  readonly id: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly color?: string;
};
export type ScheduleContribution = {
  readonly type: 'schedule';
  readonly id: string;
  readonly schedule: {
    readonly kind: 'interval';
    readonly everyMs: number;
  } | {
    readonly kind: 'cron';
    readonly expression: string;
  };
  readonly action: CallbackAction;
  readonly policy: {
    readonly overlap: 'skip';
    readonly timeoutMs: number;
  };
};
export type DirectToolContribution = {
  readonly type: 'tool';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly action: CallbackAction;
};
export type McpContribution = {
  readonly type: 'mcp';
  readonly id: string;
  readonly runtime: ContributionRuntime;
  readonly environment?: Readonly<Record<string, EnvironmentBinding>>;
};
export type SkillContribution = {
  readonly type: 'skill';
  readonly id: string;
  readonly path: PackageRelativePath;
};
export type LimbContribution = {
  readonly type: 'limb';
  readonly id: string;
  readonly manifestPath: PackageRelativePath;
};
export type WebhookContribution = {
  readonly type: 'webhook';
  readonly id: string;
  readonly path: string;
  readonly methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[];
  readonly action: CallbackAction;
  readonly verificationSecretRef?: string;
};
export type MessageSubscriptionContribution = {
  readonly type: 'message-subscription';
  readonly id: string;
  readonly binding: string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly action: CallbackAction;
};
export type ServiceContribution = {
  readonly type: 'service';
  readonly id: string;
  readonly runtime: ContributionRuntime;
  readonly healthMethod: string;
  readonly environment?: Readonly<Record<string, EnvironmentBinding>>;
};
export type ConnectorContribution = {
  readonly type: 'connector';
  readonly id: string;
  readonly identityRef: string;
  readonly inboundMethod: string;
  readonly outboundMethod: string;
};
export type UiWhenClause = {
  readonly featureEnabled?: boolean;
  readonly requiresCapabilities?: readonly Capability[];
};
export type UiAnchor = {
  readonly position: 'before' | 'after';
  readonly target: string;
};
export type UiCommandContribution = {
  readonly type: 'ui';
  readonly id: string;
  readonly kind: 'command';
  readonly label: string;
  readonly action: CallbackAction;
  readonly when?: UiWhenClause;
};
export type UiSlotItemContribution = {
  readonly type: 'ui';
  readonly id: string;
  readonly kind: 'slot-item';
  readonly label: string;
  readonly command: string;
  readonly group: string;
  readonly anchor?: UiAnchor;
  readonly order?: number;
  readonly when?: UiWhenClause;
};
export type UiMessageElementContribution = {
  readonly type: 'ui';
  readonly id: string;
  readonly kind: 'message-element';
  readonly label: string;
  readonly elementKind: string;
  readonly renderer: string;
  readonly when?: UiWhenClause;
};
export type UiContribution = UiCommandContribution | UiSlotItemContribution | UiMessageElementContribution;
export type StaticContribution = IdentityContribution | ScheduleContribution | DirectToolContribution | McpContribution | SkillContribution | LimbContribution | WebhookContribution | MessageSubscriptionContribution | ServiceContribution | ConnectorContribution | UiContribution;
export type PluginFeature = {
  readonly id: string;
  readonly name: string;
  readonly resources: readonly ResourceReference[];
  readonly contributions?: readonly ContributionReference[];
  readonly capabilities: readonly Capability[];
};
export type RuntimeTransport = 'stdio' | 'ipc' | 'builtin';
export type ExternalRuntimeTransport = 'stdio' | 'ipc';
export type ExternalRuntimeDeclaration = {
  readonly transport: ExternalRuntimeTransport;
  readonly entrypoint: PackageRelativePath;
};
export type BuiltinRuntimeDeclaration = {
  readonly transport: 'builtin';
  readonly entrypoint?: string;
};
export type RuntimeDeclaration = ExternalRuntimeDeclaration | BuiltinRuntimeDeclaration;

export type PluginManifest = {
  readonly pluginId: string;
  readonly version: SemVer;
  readonly contractVersion: SemVer;
  readonly name: string;
  readonly description?: LocalizedDescription;
  readonly icon?: PluginIcon;
  readonly configuration?: readonly ConfigurationField[];
  readonly contributions?: readonly StaticContribution[];
  readonly features: readonly PluginFeature[];
  readonly data?: readonly DataDeclaration[];
  readonly runtime: RuntimeDeclaration;
  readonly signals?: SignalContribution;
};

export type CatalogSemVer = string;
export type CatalogPublisher = {
  readonly id: string;
  readonly name: string;
};
export type ArtifactProvenance = {
  readonly repository: string;
  readonly sourceDirectory: string;
};
export type NpmArtifact = {
  readonly kind: 'npm';
  readonly packageName: string;
  readonly version: CatalogSemVer;
  readonly tarballUrl: string;
  readonly integrity: string;
  readonly shasum: string;
  readonly provenance: ArtifactProvenance;
};
export type CatalogPluginVersion = {
  readonly version: CatalogSemVer;
  readonly contractVersion: CatalogSemVer;
  readonly manifestPath: 'plugin.yaml';
  readonly artifact: NpmArtifact;
};
export type CatalogPluginEntry = {
  readonly pluginId: string;
  readonly name: string;
  readonly description: LocalizedDescription;
  readonly icon: PluginIcon;
  readonly publisher: CatalogPublisher;
  readonly keywords?: readonly string[];
  readonly versions: readonly CatalogPluginVersion[];
};

export type PluginCatalog = {
  readonly schemaVersion: '1';
  readonly plugins: readonly CatalogPluginEntry[];
};

export type SignalType = string;
export type SignalSchemaRef = string;
export type SignalEpistemicStatus = 'observation' | 'inference';
export type SignalPrivacyClass = 'behavioral' | 'content-adjacent' | 'content' | 'av-raw' | 'input-raw';
export type AdmissibleSignalPrivacyClass = 'behavioral' | 'content-adjacent' | 'content';
export type SignalSourceClass = 'os-metadata' | 'accessibility-api' | 'remote-service' | 'av-capture' | 'input-hardware';
export type AdmissibleSignalSourceClass = 'os-metadata' | 'accessibility-api' | 'remote-service';
export type SignalDeclaration = {
  readonly type: SignalType;
  readonly schemaRef: SignalSchemaRef;
  readonly epistemicStatus: SignalEpistemicStatus;
  readonly privacyClass: AdmissibleSignalPrivacyClass;
  readonly sourceClass: AdmissibleSignalSourceClass;
};
export type SignalContribution = {
  readonly provides: readonly SignalDeclaration[];
};
export type SignalEventId = string;
export type SignalIdempotencyKey = string;
export type OpaqueSourceHandle = string;
export type SignalSourceRef = {
  readonly handle: OpaqueSourceHandle;
};
export type EventsPublishInput = {
  readonly signalType: SignalType;
  readonly eventId: SignalEventId;
  readonly idempotencyKey: SignalIdempotencyKey;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source: SignalSourceRef;
};
export type EventsPublishDisposition = 'accepted' | 'duplicate';
export type EventsPublishResult = {
  readonly publicationId: SignalEventId;
  readonly disposition: EventsPublishDisposition;
};

export type ActorKind = 'user' | 'cat' | 'plugin' | 'device' | 'system';
export type ActorRef = {
  readonly kind: ActorKind;
  readonly id: string;
};
export type EpistemicStatus = 'observation' | 'user_intent' | 'inference';
export type ExternalSourceAddress = {
  readonly connectorId: string;
  readonly chatId: string;
  readonly messageId?: string;
};
export type IngressSourceAddress = ExternalSourceAddress;
export type PluginOrigin = {
  readonly kind: 'plugin';
  readonly instanceId: string;
};
export type ExternalOrigin = {
  readonly kind: 'external';
  readonly connectorId: string;
  readonly sourceAddress?: ExternalSourceAddress;
};
export type HostOrigin = {
  readonly kind: 'host';
};
export type ProvenanceOrigin = PluginOrigin | ExternalOrigin | HostOrigin;
export type DraftOrigin = PluginOrigin | ExternalOrigin;
export type MessageProvenance = {
  readonly origin: ProvenanceOrigin;
  readonly epistemicStatus: EpistemicStatus;
};
export type DraftProvenance = {
  readonly origin?: DraftOrigin;
  readonly epistemicStatus: EpistemicStatus;
};
export type ElementKind = 'text' | 'media_ref' | 'rich_block';
export type TextElementPayload = {
  readonly text: string;
};
export type MediaRefElementPayload = Readonly<Record<string, unknown>>;
export type RichBlockElementPayload = Readonly<Record<string, unknown>>;
export type TextMessageElement = {
  readonly elementId: string;
  readonly kind: 'text';
  readonly payload: TextElementPayload;
  readonly derivedFromElementId?: string;
  readonly epistemicStatus?: EpistemicStatus;
};
export type MediaRefMessageElement = {
  readonly elementId: string;
  readonly kind: 'media_ref';
  readonly payload: MediaRefElementPayload;
  readonly derivedFromElementId?: string;
  readonly epistemicStatus?: EpistemicStatus;
};
export type RichBlockMessageElement = {
  readonly elementId: string;
  readonly kind: 'rich_block';
  readonly payload: RichBlockElementPayload;
  readonly derivedFromElementId?: string;
  readonly epistemicStatus?: EpistemicStatus;
};
export type MessageElement = TextMessageElement | MediaRefMessageElement | RichBlockMessageElement;
export type MessagePayload = {
  readonly provenance: MessageProvenance;
  readonly elements: readonly MessageElement[];
  readonly correlationId?: string;
  readonly causationId?: string;
};
export type DraftPayload = {
  readonly provenance: DraftProvenance;
  readonly elements: readonly MessageElement[];
  readonly correlationId?: string;
  readonly causationId?: string;
};
export type ThreadHandleAddress = {
  readonly kind: 'thread_handle';
  readonly handle: string;
};
export type ConnectorBindingAddress = {
  readonly kind: 'connector_binding';
  readonly handle: string;
};
export type MessageAddress = ThreadHandleAddress | ConnectorBindingAddress;
export type PublicAudience = {
  readonly kind: 'public';
};
export type WhisperAudience = {
  readonly kind: 'whisper';
  readonly targets: readonly string[];
};
export type SystemAudience = {
  readonly kind: 'system';
};
export type DraftAudience = PublicAudience | WhisperAudience;
export type CanonicalAudience = PublicAudience | WhisperAudience | SystemAudience;
export type MessageDraft = {
  readonly address: MessageAddress;
  readonly draftAudience?: DraftAudience;
  readonly idempotencyKey: string;
  readonly sourceEventId?: string;
  readonly replyTo?: string;
  readonly payload: DraftPayload;
};
export type OccurredAt = string | string;
export type MessageEnvelope = {
  readonly messageId: string;
  readonly revision: number;
  readonly threadId: string;
  readonly replyTo?: string;
  readonly actor: ActorRef;
  readonly audience: CanonicalAudience;
  readonly occurredAt: OccurredAt;
  readonly payload: MessagePayload;
};
export type MessagePublishEvent = {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: 'message.publish';
  readonly envelope: MessageEnvelope;
};
export type MessageElementsAppendEvent = {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: 'message.elements.append';
  readonly messageId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly baseRevision?: number;
  readonly revision: number;
  readonly elements: readonly MessageElement[];
};
export type MessageOutputEvent = MessagePublishEvent | MessageElementsAppendEvent;
export type SendReceipt = {
  readonly messageId: string;
  readonly threadId: string;
  readonly revision: number;
  readonly messageHandle: MessageHandle;
  readonly publishSequence?: number;
};
export type AppendReceipt = {
  readonly messageId: string;
  readonly revision: number;
  readonly appendSequence?: number;
  readonly appliedElementIds: readonly string[];
};
export type MessagingErrorCode = 'VALIDATION' | 'PERMISSION' | 'NOT_FOUND' | 'CONFLICT' | 'RETRYABLE_INFLIGHT' | 'STALE_CURSOR';
export type MessageHandle = {
  readonly kind: 'message';
  readonly token: string;
};
export type AppendElementsRequest = {
  readonly handle: MessageHandle;
  readonly operationId: string;
  readonly baseRevision?: number;
  readonly elements: readonly MessageElement[];
};
export type SubscriptionCursor = string;
export type SubscriptionNormalResponse = {
  readonly events: readonly MessageOutputEvent[];
  readonly ackToken: SubscriptionCursor;
  readonly stale: false;
};
export type SubscriptionEmptyResponse = {
  readonly events: readonly [];
  readonly ackToken: null;
  readonly stale: false;
};
export type SubscriptionStaleResponse = {
  readonly events: readonly [];
  readonly ackToken: null;
  readonly stale: true;
};
export type SubscriptionReadResponse = SubscriptionNormalResponse | SubscriptionEmptyResponse | SubscriptionStaleResponse;
export type SnapshotResponse = {
  readonly envelopes: readonly MessageEnvelope[];
  readonly resumeSequence: number;
};
export type M0CSubscribeInput = {
  readonly handle: string;
};
export type M0CSubscribeResult = {
  readonly subscriptionId: string;
};
export type M0CReadInput = {
  readonly subscriptionId: string;
  readonly limit: number;
};
export type M0CReadNormalResult = {
  readonly events: readonly MessageOutputEvent[];
  readonly ackToken: string;
  readonly stale: false;
};
export type M0CReadEmptyResult = {
  readonly events: readonly [];
  readonly ackToken: null;
  readonly stale: false;
};
export type M0CReadStaleResult = {
  readonly events: readonly [];
  readonly ackToken: null;
  readonly stale: true;
};
export type M0CReadResult = M0CReadNormalResult | M0CReadEmptyResult | M0CReadStaleResult;
export type M0CAckInput = {
  readonly subscriptionId: string;
  readonly ackToken: string;
};
export type M0CAckResult = null;
export type M0CSnapshotInput = {
  readonly subscriptionId: string;
  readonly maxItems: number;
  readonly pageToken?: string;
};
export type M0CSnapshotIntermediateResult = {
  readonly items: readonly MessageEnvelope[];
  readonly nextPageToken: string;
  readonly snapshotAckToken: null;
};
export type M0CSnapshotFinalResult = {
  readonly items: readonly MessageEnvelope[];
  readonly nextPageToken: null;
  readonly snapshotAckToken: string;
};
export type M0CSnapshotResult = M0CSnapshotIntermediateResult | M0CSnapshotFinalResult;
export type M0CDeliverInput = {
  readonly deliveryId: string;
  readonly threadHandle: ThreadHandleAddress;
  readonly envelope: MessageEnvelope;
};
export type M0CDeliverResult = {
  readonly deliveryId: string;
};

export type PhysicalLimbIdentifier = string;
export type PhysicalLimbGrant = 'limb.action.motion' | 'limb.action.display' | 'limb.action.light' | 'limb.action.speaker' | 'limb.observe.touch' | 'limb.sensor.microphone' | 'limb.sensor.camera';
export type PhysicalLimbSafePose = {
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly timeoutMs: number;
};
export type PhysicalLimbContribution = {
  readonly contributionId: PhysicalLimbIdentifier;
  readonly nodeType: PhysicalLimbIdentifier;
  readonly displayName: string;
  readonly grants: readonly PhysicalLimbGrant[];
  readonly safePose: PhysicalLimbSafePose;
};
export type PhysicalLimbExpressionSource = {
  readonly kind: 'cat_state' | 'play' | 'degraded';
  readonly ref: PhysicalLimbIdentifier;
};
export type PhysicalLimbTouchPayload = {
  readonly gesture: 'tap' | 'stroke';
  readonly durationMs: number;
  readonly confidence: number;
};
export type PhysicalLimbTranscriptPayload = {
  readonly interactionId: PhysicalLimbIdentifier;
  readonly text: string;
  readonly language?: string;
  readonly captureDurationMs: number;
};
export type PhysicalLimbTouchObservation = {
  readonly v: 1;
  readonly observationId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly occurredAt: string;
  readonly sessionId: PhysicalLimbIdentifier;
  readonly kind: 'touch';
  readonly payload: PhysicalLimbTouchPayload;
};
export type PhysicalLimbTranscriptObservation = {
  readonly v: 1;
  readonly observationId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly occurredAt: string;
  readonly sessionId: PhysicalLimbIdentifier;
  readonly kind: 'transcript';
  readonly payload: PhysicalLimbTranscriptPayload;
};
export type PhysicalLimbObservation = PhysicalLimbTouchObservation | PhysicalLimbTranscriptObservation;
export type PhysicalLimbMotionPayload = {
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly speedDps: number;
  readonly accelerationDps2: number;
};
export type PhysicalLimbDisplayPayload = {
  readonly expression: string;
  readonly expressionSource: PhysicalLimbExpressionSource;
};
export type PhysicalLimbRgb = readonly [number, number, number];
export type PhysicalLimbLightPayload = {
  readonly colors: readonly PhysicalLimbRgb[];
};
export type PhysicalLimbSpeakerPayload = {
  readonly text: string;
  readonly voiceProfileRef: PhysicalLimbIdentifier;
  readonly volumePercent: number;
};
export type PhysicalLimbMotionAction = {
  readonly v: 1;
  readonly actionId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly deadlineUnixMs: number;
  readonly timeoutMs: number;
  readonly cancelToken: PhysicalLimbIdentifier;
  readonly kind: 'motion';
  readonly payload: PhysicalLimbMotionPayload;
};
export type PhysicalLimbDisplayAction = {
  readonly v: 1;
  readonly actionId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly deadlineUnixMs: number;
  readonly timeoutMs: number;
  readonly cancelToken: PhysicalLimbIdentifier;
  readonly kind: 'display';
  readonly payload: PhysicalLimbDisplayPayload;
};
export type PhysicalLimbLightAction = {
  readonly v: 1;
  readonly actionId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly deadlineUnixMs: number;
  readonly timeoutMs: number;
  readonly cancelToken: PhysicalLimbIdentifier;
  readonly kind: 'light';
  readonly payload: PhysicalLimbLightPayload;
};
export type PhysicalLimbSpeakerAction = {
  readonly v: 1;
  readonly actionId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly deadlineUnixMs: number;
  readonly timeoutMs: number;
  readonly cancelToken: PhysicalLimbIdentifier;
  readonly kind: 'speaker';
  readonly payload: PhysicalLimbSpeakerPayload;
};
export type PhysicalLimbAction = PhysicalLimbMotionAction | PhysicalLimbDisplayAction | PhysicalLimbLightAction | PhysicalLimbSpeakerAction;
export type PhysicalLimbCancel = {
  readonly v: 1;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly actionId: PhysicalLimbIdentifier;
  readonly cancelToken: PhysicalLimbIdentifier;
  readonly reason: 'user' | 'timeout' | 'lease_lost' | 'host_lost' | 'superseded';
};
export type PhysicalLimbActionResult = {
  readonly v: 1;
  readonly actionId: PhysicalLimbIdentifier;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly outcome: 'succeeded' | 'refused' | 'failed' | 'canceled';
  readonly reason?: string;
  readonly observedAt: string;
};
export type PhysicalLimbReadinessReason = 'gateway_disconnected' | 'device_disconnected' | 'firmware_incompatible' | 'sensor_unavailable' | 'speech_dependency_missing' | 'skin_unavailable' | 'grant_revoked' | 'host_unavailable';
export type PhysicalLimbReadyReadiness = {
  readonly v: 1;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly status: 'ready';
  readonly observedAt: string;
};
export type PhysicalLimbUnavailableReadiness = {
  readonly v: 1;
  readonly nodeId: PhysicalLimbIdentifier;
  readonly status: 'degraded' | 'offline';
  readonly reason: PhysicalLimbReadinessReason;
  readonly observedAt: string;
};
export type PhysicalLimbReadiness = PhysicalLimbReadyReadiness | PhysicalLimbUnavailableReadiness;

export type FixtureMetadata = {
  readonly executor: 'loopback';
  readonly domain: 'messaging';
  readonly contractVersion: string;
  readonly source: string;
  readonly description: string;
};
export type FixtureCaller = {
  readonly pluginInstanceId: string;
};
export type FixtureHandle = {
  readonly kind: 'thread_handle' | 'connector_binding' | 'message_handle' | 'subscription';
  readonly token: string;
  readonly ownerPluginInstanceId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly connectorId?: string;
  readonly subscriptionId?: string;
};
export type FixtureSetup = {
  readonly caller: FixtureCaller;
  readonly grants: readonly CapabilityName[];
  readonly handles: Readonly<Record<string, FixtureHandle>>;
  readonly state: Readonly<Record<string, unknown>>;
};
export type FixtureOperation = {
  readonly operation: 'send';
  readonly input: SendOperationInput;
} | {
  readonly operation: 'appendElements';
  readonly input: AppendOperationInput;
} | {
  readonly operation: 'subscribe';
  readonly input: SubscribeOperationInput;
} | {
  readonly operation: 'read';
  readonly input: ReadOperationInput;
} | {
  readonly operation: 'ack';
  readonly input: AckOperationInput;
} | {
  readonly operation: 'snapshot';
  readonly input: SnapshotOperationInput;
} | {
  readonly operation: 'applyGrantPreset';
  readonly input: GrantPresetInput;
} | {
  readonly operation: 'revokeGrant';
  readonly input: RevokeGrantInput;
} | {
  readonly operation: 'deliverOnMessage';
  readonly input: OnMessageDeliveryInput;
} | {
  readonly operation: 'checkPermissionMatrix';
  readonly input: PermissionMatrixInput;
} | {
  readonly operation: 'deleteReplayEvents';
  readonly input: DeleteReplayEventsInput;
};
export type PluginToHostMethod = 'messaging.send' | 'messaging.appendElements' | 'messaging.subscribe' | 'messaging.read' | 'messaging.ack' | 'messaging.snapshot';
export type BehaviorExpectationOracle = {
  readonly kind: 'behavior-expectation';
};
export type JsonRpcAdmissionOracle = {
  readonly kind: 'json-rpc-error';
  readonly code: -32602;
  readonly sideEffects: 'behavior-expectation';
};
export type BehaviorExecution = {
  readonly plane: 'plugin-to-host-wire';
  readonly method: PluginToHostMethod;
  readonly verdictOracle: BehaviorExpectationOracle;
} | {
  readonly plane: 'wire-admission';
  readonly method: PluginToHostMethod;
  readonly verdictOracle: JsonRpcAdmissionOracle;
} | {
  readonly plane: 'host-to-plugin-delivery';
  readonly method: 'host.messaging.deliver';
  readonly verdictOracle: BehaviorExpectationOracle;
} | {
  readonly plane: 'host-control';
  readonly verdictOracle: BehaviorExpectationOracle;
};
export type SendOperationInput = {
  readonly address: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
};
export type AppendOperationInput = {
  readonly handle: Readonly<Record<string, unknown>>;
  readonly operationId: string;
  readonly elements: readonly unknown[];
};
export type SubscribeOperationInput = {
  readonly handleId: string;
};
export type ReadOperationInput = {
  readonly subscriptionId: string;
  readonly limit?: number;
};
export type AckOperationInput = {
  readonly subscriptionId: string;
  readonly ackToken: string;
};
export type SnapshotOperationInput = {
  readonly subscriptionId: string;
};
export type CapabilityName = Capability;
export type GrantPresetInput = {
  readonly presetKind: 'first_party';
  readonly capabilities: readonly CapabilityName[];
};
export type RevokeGrantInput = {
  readonly capability: CapabilityName;
};
export type OnMessageDeliveryInput = {
  readonly threadHandle: string;
  readonly envelope: Readonly<Record<string, unknown>>;
};
export type PermissionMatrixEntry = {
  readonly capability: CapabilityName;
  readonly layer: 'L0' | 'L1' | 'L2';
  readonly firstPartyPreset: boolean;
};
export type PermissionMatrixInput = {
  readonly entries: readonly [PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry, PermissionMatrixEntry];
};
export type DeleteReplayEventsInput = {
  readonly subscriptionId: string;
  readonly throughSequence: number;
};
export type SideEffectAssertion = {
  readonly target: 'messages' | 'output_events' | 'idempotency_ledger' | 'subscription' | 'snapshot' | 'reply_preview' | 'provenance' | 'grant_state' | 'permission_matrix' | 'replay_events';
  readonly assertion: 'unchanged';
  readonly value?: never;
} | {
  readonly target: 'messages' | 'output_events' | 'idempotency_ledger' | 'subscription' | 'snapshot' | 'reply_preview' | 'provenance' | 'grant_state' | 'permission_matrix' | 'replay_events';
  readonly assertion: 'none';
  readonly value?: never;
} | {
  readonly target: 'messages' | 'output_events' | 'idempotency_ledger' | 'subscription' | 'snapshot' | 'reply_preview' | 'provenance' | 'grant_state' | 'permission_matrix' | 'replay_events';
  readonly assertion: 'state_equals';
  readonly value: unknown;
} | {
  readonly target: 'messages' | 'output_events' | 'idempotency_ledger' | 'subscription' | 'snapshot' | 'reply_preview' | 'provenance' | 'grant_state' | 'permission_matrix' | 'replay_events';
  readonly assertion: 'round_trip';
  readonly value: unknown;
} | {
  readonly target: 'messages' | 'output_events' | 'idempotency_ledger' | 'subscription' | 'snapshot' | 'reply_preview' | 'provenance' | 'grant_state' | 'permission_matrix' | 'replay_events';
  readonly assertion: 'matches';
  readonly value: unknown;
};
export type ExpectedVerdict = {
  readonly status: 'success';
  readonly errorCode?: never;
  readonly sideEffects: readonly SideEffectAssertion[];
} | {
  readonly status: 'error';
  readonly errorCode: MessagingErrorCode;
  readonly sideEffects: readonly SideEffectAssertion[];
};
export type BehaviorCase = {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'plugin-to-host-wire' }> & { readonly method: 'messaging.send' } | Extract<BehaviorExecution, { readonly plane: 'wire-admission' }> & { readonly method: 'messaging.send' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'send' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'plugin-to-host-wire' }> & { readonly method: 'messaging.appendElements' } | Extract<BehaviorExecution, { readonly plane: 'wire-admission' }> & { readonly method: 'messaging.appendElements' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'appendElements' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'plugin-to-host-wire' }> & { readonly method: 'messaging.subscribe' } | Extract<BehaviorExecution, { readonly plane: 'wire-admission' }> & { readonly method: 'messaging.subscribe' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'subscribe' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'plugin-to-host-wire' }> & { readonly method: 'messaging.read' } | Extract<BehaviorExecution, { readonly plane: 'wire-admission' }> & { readonly method: 'messaging.read' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'read' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'plugin-to-host-wire' }> & { readonly method: 'messaging.ack' } | Extract<BehaviorExecution, { readonly plane: 'wire-admission' }> & { readonly method: 'messaging.ack' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'ack' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'plugin-to-host-wire' }> & { readonly method: 'messaging.snapshot' } | Extract<BehaviorExecution, { readonly plane: 'wire-admission' }> & { readonly method: 'messaging.snapshot' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'snapshot' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'host-to-plugin-delivery' }> & { readonly method: 'host.messaging.deliver' };
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'deliverOnMessage' }>;
  readonly expect: ExpectedVerdict;
} | {
  readonly id: string;
  readonly invariant: string;
  readonly execution: Extract<BehaviorExecution, { readonly plane: 'host-control' }>;
  readonly given: FixtureSetup;
  readonly when: Extract<FixtureOperation, { readonly operation: 'applyGrantPreset' | 'revokeGrant' | 'checkPermissionMatrix' | 'deleteReplayEvents' }>;
  readonly expect: ExpectedVerdict;
};

export type BehaviorFixture = {
  readonly _meta: FixtureMetadata;
  readonly cases: readonly BehaviorCase[];
};

export const L0_CAPABILITIES = ['plugin.config.read', 'plugin.state.get', 'plugin.state.set'] as const;
export type L0Capability = (typeof L0_CAPABILITIES)[number];
export const L1_CAPABILITIES = ['messaging.send', 'schedule.register', 'events.publish', 'messaging.appendElements'] as const;
export type L1Capability = (typeof L1_CAPABILITIES)[number];
export const L2_CAPABILITIES = ['onMessage', 'message.event.subscribe', 'secret.read', 'thread.listMetadata', 'thread.readContent', 'memory.query', 'memory.append', 'memory.retrieve', 'windows.create', 'whisper.extend'] as const;
export type L2Capability = (typeof L2_CAPABILITIES)[number];
export const CAPABILITY_TABLE = {
  L0: L0_CAPABILITIES,
  L1: L1_CAPABILITIES,
  L2: L2_CAPABILITIES,
} as const;
export type AuthorizationLayer = keyof typeof CAPABILITY_TABLE;

export const DATA_CLASS_ALLOWED_STRATEGIES = {
  'cache': ['lifecycle', 'retained', 'ask-on-uninstall'],
  'ephemeral': ['lifecycle', 'retained', 'ask-on-uninstall'],
  'user-authored': ['retained', 'ask-on-uninstall'],
  'derived-user-visible': ['retained', 'ask-on-uninstall'],
  'relationship': ['retained', 'ask-on-uninstall'],
  'interaction-history': ['retained', 'ask-on-uninstall'],
} as const satisfies Readonly<Record<DataClass, readonly DataStrategy[]>>;

export const MESSAGING_BOUNDS = {
  maxElementsPerOperation: 32,
  maxElementPayloadBytes: 65536,
  maxTotalPayloadBytes: 262144,
  maxWhisperTargets: 16,
  maxIdempotencyKeyLength: 200,
  maxElementIdLength: 128,
  maxElementsPerMessage: 128,
  maxAppendOpsPerMessage: 64,
  maxMessageIdLength: 512,
  maxThreadIdLength: 512,
  maxActorIdLength: 512,
  maxMessageHandleTokenLength: 512,
  maxEventIdLength: 720,
  maxOccurredAtLength: 27,
} as const;

/**
 * @signed(G-0 2026-07-15)
 * Host control plane/UI obligation: expose effective retention to users.
 * This does not add a plugin handshake field or query API.
 */
export const MESSAGING_REPLAY_WINDOW_DEFAULT = 'P7D' as const;
