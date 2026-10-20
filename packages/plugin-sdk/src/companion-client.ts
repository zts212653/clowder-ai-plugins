import type {
  CompanionCommand,
  CompanionConversationBodyV2,
  CompanionConversationDraftV1,
  CompanionConversationPageV2,
  CompanionDeliveryReceiptV2,
  CompanionErrorCode,
  CompanionEvent,
  CompanionReply,
  CompanionSettingField,
  CompanionSettingsValues,
} from '@clowder-ai/plugin-contract';

type CompanionConversationV1 = Exclude<
  Extract<CompanionReply, { kind: 'conversation' }>,
  CompanionConversationPageV2
>;
type CompanionConversationReadV2 = Extract<CompanionCommand, { kind: 'conversation.read'; v: 2 }>;
export type CompanionConversationPageOptions = Pick<CompanionConversationReadV2, 'before' | 'limit'>;

/** Installed by the trusted desktop preload. It carries no host URL or identity selectors. */
export interface CompanionSurfaceBridge {
  request(command: CompanionCommand): Promise<CompanionReply>;
  subscribe(listener: (event: CompanionEvent) => void): () => void;
}

export class CompanionRequestError extends Error {
  constructor(readonly code: CompanionErrorCode) { super(code); this.name = 'CompanionRequestError'; }
}

export type CompanionPresentationObservation = Omit<
  Extract<CompanionCommand, { kind: 'presentation.observe' }>,
  'kind'
>;

/** Browser-safe client: no Node imports, credentials, second transcript store or transport fallback. */
export function createCompanionClient(bridge: CompanionSurfaceBridge) {
  async function invoke<K extends CompanionReply['kind']>(command: CompanionCommand, kind: K): Promise<Extract<CompanionReply, { kind: K }>> {
    const reply = await bridge.request(command);
    if (reply.kind === 'error') throw new CompanionRequestError(reply.code);
    if (reply.kind !== kind) throw new CompanionRequestError('unavailable');
    return reply as Extract<CompanionReply, { kind: K }>;
  }
  async function readConversation(): Promise<CompanionConversationV1> {
    const response = await invoke({ kind: 'conversation.read' }, 'conversation');
    if ('v' in response) throw new CompanionRequestError('unavailable');
    return response;
  }
  async function readConversationPage(
    options: CompanionConversationPageOptions = {},
  ): Promise<CompanionConversationPageV2> {
    const command: CompanionConversationReadV2 = options.before === undefined
      ? options.limit === undefined
        ? { kind: 'conversation.read', v: 2 }
        : { kind: 'conversation.read', v: 2, limit: options.limit }
      : options.limit === undefined
        ? { kind: 'conversation.read', v: 2, before: options.before }
        : { kind: 'conversation.read', v: 2, before: options.before, limit: options.limit };
    const response = await invoke(command, 'conversation');
    if (!('v' in response) || response.v !== 2) throw new CompanionRequestError('unavailable');
    return response;
  }
  async function readConversationBody(continuation: string): Promise<CompanionConversationBodyV2> {
    return invoke({ kind: 'conversation.body.read', v: 2, continuation }, 'conversation-body');
  }
  async function readConversationDraft(): Promise<CompanionConversationDraftV1> {
    return invoke({ kind: 'conversation.draft.read', v: 1 }, 'conversation-draft');
  }
  async function saveConversationDraft(
    expectedRevision: number,
    text: string,
    scopeRef: string,
  ): Promise<CompanionConversationDraftV1> {
    return invoke({
      kind: 'conversation.draft.save', v: 1, scopeRef, expectedRevision, text,
    }, 'conversation-draft');
  }
  async function invokeDeliveryV2(command: CompanionCommand): Promise<CompanionDeliveryReceiptV2> {
    const response = await invoke(command, 'delivery');
    if (!('v' in response) || response.v !== 2) throw new CompanionRequestError('unavailable');
    return response;
  }
  async function submitConversationText(
    text: string,
    clientMessageId: string,
    submissionRevision: number,
    scopeRef: string,
  ): Promise<CompanionDeliveryReceiptV2> {
    return invokeDeliveryV2({
      kind: 'text', v: 2, scopeRef, text, clientMessageId, submissionRevision,
    });
  }
  async function readConversationDelivery(
    clientMessageId: string,
    scopeRef: string,
  ): Promise<CompanionDeliveryReceiptV2> {
    return invokeDeliveryV2({ kind: 'conversation.delivery.read', v: 1, scopeRef, clientMessageId });
  }
  return {
    state: () => invoke({ kind: 'state' }, 'state'),
    prepare: () => invoke({ kind: 'prepare' }, 'state'),
    connectAudio: (mode?: Extract<CompanionCommand, { kind: 'audio.connect' }>['mode']) =>
      invoke(mode === undefined ? { kind: 'audio.connect' } : { kind: 'audio.connect', mode }, 'ok'),
    closeAudio: () => invoke({ kind: 'audio.close' }, 'ok'),
    muteMicrophone: (muted: boolean) => invoke({ kind: 'audio.microphone', muted }, 'ok'),
    muteSpeaker: (muted: boolean) => invoke({ kind: 'audio.speaker', muted }, 'ok'),
    stop: () => invoke({ kind: 'stop' }, 'ok'),
    text: async (text: string, clientMessageId: string) => {
      const receipt = await invoke({ kind: 'text', text, clientMessageId }, 'delivery');
      if ('v' in receipt) throw new CompanionRequestError('unavailable');
      if (receipt.delivery !== 'accepted') throw new CompanionRequestError('unconfirmed');
      return receipt;
    },
    documents: (allowed: boolean) => invoke({ kind: 'documents', allowed }, 'state'),
    screenPick: async () => (await invoke({ kind: 'screen.pick' }, 'selection')).selectionId,
    screenOpen: (selectionId: string, label: string) => invoke({ kind: 'screen.open', selectionId, label }, 'ok'),
    screenFrame: (selectionId: string, frame: Extract<CompanionCommand, { kind: 'screen.frame' }>['frame']) =>
      invoke({ kind: 'screen.frame', selectionId, frame }, 'ok'),
    screenClose: () => invoke({ kind: 'screen.close' }, 'ok'),
    openConversation: () => invoke({ kind: 'conversation.open' }, 'navigation'),
    observePresentation: (observation: CompanionPresentationObservation) =>
      invoke({
        kind: 'presentation.observe',
        event: observation.event,
        observedAt: observation.observedAt,
        callId: observation.callId,
        reference: observation.reference,
      }, 'ok'),
    readWork: () => invoke({ kind: 'work.read' }, 'work'),
    openWork: (entryRef: string) => invoke({ kind: 'work.open', entryRef }, 'navigation'),
    readDecisions: (offset = 0, limit = 20) => invoke({ kind: 'decisions.read', offset, limit }, 'decisions'),
    openDecision: (
      variantRef: string,
      target: Extract<CompanionCommand, { kind: 'decision.open' }>['target'],
    ) => invoke({ kind: 'decision.open', variantRef, target }, 'navigation'),
    inspectF221: (proposalId: string) => invoke({ kind: 'f221.inspect', proposalId }, 'decision-trial'),
    resize: (expanded: boolean) => invoke({ kind: 'view.resize', expanded }, 'ok'),
    layout: (
      panel: Extract<CompanionCommand, { kind: 'view.layout' }>['panel'],
      width: number,
      height: number,
      call?: Extract<CompanionCommand, { kind: 'view.layout' }>['call'],
    ) => invoke(call === undefined
      ? { kind: 'view.layout', panel, width, height }
      : { kind: 'view.layout', panel, width, height, call }, 'layout'),
    drag: (phase: 'start' | 'end') => invoke({ kind: 'view.drag', phase }, 'ok'),
    hide: () => invoke({ kind: 'view.hide' }, 'ok'),
    resetPosition: () => invoke({ kind: 'view.reset' }, 'ok'),
    readSettings: () => invoke({ kind: 'settings.read' }, 'settings'),
    updateSetting: <K extends CompanionSettingField>(field: K, value: CompanionSettingsValues[K]) =>
      invoke({ kind: 'settings.update', field, value } as CompanionCommand, 'settings-update'),
    settleAppAssist: (
      scopeRef: string,
      offerRef: string,
      action: Extract<CompanionCommand, { kind: 'app-assist.settle' }>['action'],
    ) => invoke({ kind: 'app-assist.settle', scopeRef, offerRef, action }, 'app-assist-settlement'),
    disableCompanion: () => invoke({ kind: 'companion.disable' }, 'companion-lifecycle'),
    readConversation,
    readConversationPage,
    readConversationBody,
    readConversationDraft,
    saveConversationDraft,
    submitConversationText,
    readConversationDelivery,
    readTranscript: () => invoke({ kind: 'transcript.read' }, 'transcript'),
    subscribe: (listener: (event: CompanionEvent) => void) => bridge.subscribe(listener),
  };
}
