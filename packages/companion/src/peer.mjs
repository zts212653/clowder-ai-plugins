/** Presentation adapter only. The Host preload owns capture, SDP and the provider channel. */
export class VoicePeer {
  constructor(onEvent, client) {
    this.onEvent = onEvent;
    this.client = client;
    this.unsubscribe = client.subscribe(event => {
      if (!this.closed && event.kind === 'audio') {
        const { kind, ...value } = event;
        this.onEvent(value);
      }
    });
  }
  async connect() { if (!this.closed) await this.client.connectAudio(); }
  muteMic(muted) { void this.client.muteMicrophone(muted).catch(() => this.failed()); }
  muteSpeaker(muted) { void this.client.muteSpeaker(muted).catch(() => this.failed()); }
  failed() { if (!this.closed) this.onEvent({ type: 'error', code: 'unavailable' }); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await this.client.closeAudio();
  }
}
