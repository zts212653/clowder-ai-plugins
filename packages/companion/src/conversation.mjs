import { explainError } from './errors.mjs';

/** Local controls only. Durable messages, identity and preferences belong to the Host. */
export class CompanionConversation {
  constructor({ client, createPeer, render, transcript, stopScreen, uuid = () => crypto.randomUUID() }) {
    Object.assign(this, { client, createPeer, render, transcript, stopScreen, uuid });
    this.active = false;
    this.generation = 0;
    this.phase = 'idle';
    this.muted = false;
    this.silent = false;
  }
  show(message) {
    this.message = message;
    this.render({ phase: this.phase, identity: this.identity, muted: this.muted, silent: this.silent, message });
  }
  current(generation) { return this.active && generation === this.generation; }
  listening() { return this.muted ? '麦克风已静音' : '正在听，直接说话就好'; }
  async begin() {
    if (this.active || this.stopping || this.changingDocuments) return;
    this.active = true;
    this.phase = 'connecting';
    const generation = ++this.generation;
    // Must reach the isolated preload while the click still has user activation.
    const preparation = this.client.prepare();
    this.show('正在连接…');
    this.deadline = setTimeout(() => { if (this.current(generation)) void this.end('连接超时 · 点击开始聊天重试'); }, 60_000);
    try {
      const identity = await preparation;
      if (!this.current(generation)) return;
      if (identity.phase !== 'ready') throw { code: 'unavailable' };
      this.identity = identity;
      const peer = this.createPeer(event => {
        if (!this.current(generation)) return;
        if (event.type === 'connected') { clearTimeout(this.deadline); this.phase = 'talking'; this.show(this.listening()); }
        if (event.type === 'recovering') this.show('连接暂时中断 · 正在等待恢复');
        if (event.type === 'recovered') this.show(this.listening());
        if (event.type === 'transcript' || event.type === 'turn-done') this.transcript(event);
        if (event.type === 'error') void this.end(explainError(event));
      });
      this.peer = peer;
      peer.muteMic(this.muted); peer.muteSpeaker(this.silent);
      await peer.connect();
      if (!this.current(generation)) await peer.close();
    } catch (error) {
      if (this.current(generation)) await this.end(explainError(error));
    }
  }
  async releaseLocal(message) {
    this.active = false;
    ++this.generation;
    this.pendingText = undefined;
    clearTimeout(this.deadline);
    const peer = this.peer;
    this.peer = undefined;
    this.phase = 'idle';
    this.show(message);
    await Promise.allSettled([peer?.close(), this.stopScreen()]);
  }
  async end(message = '语音已结束 · 麦克风已关闭') {
    if (this.stopping) return this.stopping;
    const local = this.releaseLocal(message);
    const operation = Promise.all([local, this.client.stop()]);
    this.stopping = operation;
    try { await operation; }
    catch { this.show('麦克风已关闭 · 连接收尾尚未确认'); }
    finally { if (this.stopping === operation) this.stopping = undefined; }
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const identity = await this.client.state();
      if (generation !== this.generation) return;
      this.identity = identity;
      if (this.active && ['closed', 'failed', 'idle'].includes(identity.phase)) {
        await this.end('连接已结束 · 点击开始聊天继续');
      } else this.show(this.message ?? '点开始聊天，直接对我说话');
    } catch (error) {
      if (generation === this.generation) {
        if (this.active) await this.end(explainError(error));
        else this.show(explainError(error));
      }
    } finally { this.refreshing = false; }
  }
  async documents(allowed) {
    if (this.changingDocuments) return;
    this.changingDocuments = true;
    // No implicit new microphone grant after changing a preference.
    const changing = this.client.documents(allowed);
    const local = this.releaseLocal('正在更新资料查询设置…');
    try {
      const identity = await changing;
      await local;
      this.identity = identity;
      this.show(allowed ? '资料查询已开启 · 点击开始聊天继续' : '资料查询已暂停 · 点击开始聊天继续');
    } catch (error) { this.show(explainError(error)); }
    finally { this.changingDocuments = false; }
  }
  async send(text) {
    text = text.trim();
    if (!text || !this.active || this.phase !== 'talking' || this.sending) return false;
    if (!this.pendingText || this.pendingText.text !== text) this.pendingText = { text, id: this.uuid() };
    const input = this.pendingText;
    const generation = this.generation;
    this.sending = true;
    try {
      await this.client.text(input.text, input.id);
      if (this.pendingText === input) this.pendingText = undefined;
      if (!this.current(generation)) return false;
      this.transcript({ type: 'transcript', role: 'user', text, typed: true });
      this.show(this.listening());
      return true;
    } catch (error) {
      if (this.current(generation)) this.show(explainError(error));
      return false;
    } finally { this.sending = false; }
  }
  muteMic() { this.muted = !this.muted; this.peer?.muteMic(this.muted); this.show(this.phase === 'talking' ? this.listening() : this.message); }
  muteSpeaker() { this.silent = !this.silent; this.peer?.muteSpeaker(this.silent); this.show(this.message); }
}
