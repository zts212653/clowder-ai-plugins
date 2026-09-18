import type { CompanionCommand, CompanionErrorCode, CompanionEvent, CompanionReply } from '@clowder-ai/plugin-contract';

/** Installed by the trusted desktop preload. It carries no host URL or identity selectors. */
export interface CompanionSurfaceBridge {
  request(command: CompanionCommand): Promise<CompanionReply>;
  subscribe(listener: (event: CompanionEvent) => void): () => void;
}

export class CompanionRequestError extends Error {
  constructor(readonly code: CompanionErrorCode) { super(code); this.name = 'CompanionRequestError'; }
}

/** Browser-safe client: no Node imports, credentials, second transcript store or transport fallback. */
export function createCompanionClient(bridge: CompanionSurfaceBridge) {
  async function invoke<K extends CompanionReply['kind']>(command: CompanionCommand, kind: K): Promise<Extract<CompanionReply, { kind: K }>> {
    const reply = await bridge.request(command);
    if (reply.kind === 'error') throw new CompanionRequestError(reply.code);
    if (reply.kind !== kind) throw new CompanionRequestError('unavailable');
    return reply as Extract<CompanionReply, { kind: K }>;
  }
  return {
    state: () => invoke({ kind: 'state' }, 'state'),
    prepare: () => invoke({ kind: 'prepare' }, 'state'),
    connectAudio: () => invoke({ kind: 'audio.connect' }, 'ok'),
    closeAudio: () => invoke({ kind: 'audio.close' }, 'ok'),
    muteMicrophone: (muted: boolean) => invoke({ kind: 'audio.microphone', muted }, 'ok'),
    muteSpeaker: (muted: boolean) => invoke({ kind: 'audio.speaker', muted }, 'ok'),
    stop: () => invoke({ kind: 'stop' }, 'ok'),
    text: async (text: string, clientMessageId: string) => {
      const receipt = await invoke({ kind: 'text', text, clientMessageId }, 'delivery');
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
    resize: (expanded: boolean) => invoke({ kind: 'view.resize', expanded }, 'ok'),
    subscribe: (listener: (event: CompanionEvent) => void) => bridge.subscribe(listener),
  };
}
