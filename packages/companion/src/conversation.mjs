import { explainError } from './errors.mjs';

/** Local controls only. Durable messages, identity and preferences belong to the Host. */
export class CompanionConversation {
  constructor({ client, createPeer, render, transcript, stopScreen, uuid = () => crypto.randomUUID() }) {
    Object.assign(this, { client, createPeer, render, transcript, stopScreen, uuid });
    this.active = false;
    this.generation = 0;
    this.phase = 'idle';
    this.audioMode = null;
    this.retryMode = null;
    this.muted = false;
    this.silent = false;
    this.failed = false;
    this.recovering = false;
    this.retiredCallId = null;
  }
  show(message) {
    this.message = message;
    this.render({ phase: this.phase, identity: this.identity, audioMode: this.audioMode, retryMode: this.retryMode,
      muted: this.muted, silent: this.silent, failed: this.failed, recovering: this.recovering,
      callId: this.callId, message });
  }
  current(generation) { return this.active && generation === this.generation; }
  listening() {
    if (this.audioMode === 'receive_only') return '只听模式 · 麦克风未启用';
    return this.muted ? '麦克风已静音' : '正在听，直接说话就好';
  }
  retrying(prefix) {
    return this.audioMode === 'receive_only'
      ? `${prefix} · 麦克风未启用，点击只听重试`
      : `${prefix} · 点击语音通话重试`;
  }
  stoppedMessage() {
    return this.audioMode === 'receive_only'
      ? '只听已结束 · 麦克风未启用'
      : '语音通话已结束 · 麦克风已关闭';
  }
  expectHostStop() {
    if (!this.active) return false;
    this.expectedHostStop = { generation: this.generation, pending: true };
    return true;
  }
  async settleExpectedHostStop(callStopped) {
    const expected = this.expectedHostStop;
    if (!expected || expected.generation !== this.generation) return;
    if (callStopped === false) {
      this.expectedHostStop = undefined;
      return;
    }
    if (callStopped === null) {
      expected.pending = false;
      return;
    }
    this.expectedHostStop = undefined;
    if (!this.active) return;
    this.failed = false;
    await this.releaseLocal(this.stoppedMessage());
  }
  async begin(mode = 'duplex') {
    if (this.active || this.stopping || this.changingDocuments) return;
    if (mode === 'receive_only' && !this.identity?.audio?.supportedModes?.includes(mode)) return;
    if (!['duplex', 'receive_only'].includes(mode)) return;
    this.active = true;
    this.audioMode = mode;
    this.retryMode = null;
    this.failed = false;
    this.recovering = false;
    this.phase = 'connecting';
    this.callId = null;
    this.expectedHostStop = undefined;
    const generation = ++this.generation;
    // Must reach the isolated preload while the click still has user activation.
    const preparation = this.client.prepare();
    this.show('正在连接…');
    this.deadline = setTimeout(() => { if (this.current(generation)) void this.end(this.retrying('连接超时'), true); }, 60_000);
    try {
      const peer = this.createPeer(event => {
        if (!this.current(generation)) return;
        if (event.type === 'error' && !this.callId && event.callId === this.retiredCallId) return;
        if (event.type === 'connected') {
          if (this.callId && this.callId !== event.callId) return;
          this.callId = event.callId;
          this.recovering = false;
          clearTimeout(this.deadline); this.phase = 'talking'; this.show(this.listening());
        }
        if (event.type === 'error' && (!event.callId || !this.callId || event.callId === this.callId)) {
          void this.end(explainError(event), true);
          return;
        }
        if (!this.callId || event.callId !== this.callId) return;
        if (event.type === 'recovering') {
          this.recovering = true;
          this.show('恢复后通话继续，无需重新连接');
        }
        if (event.type === 'recovered') {
          this.recovering = false;
          this.show(this.listening());
        }
        if (event.type === 'transcript' || event.type === 'turn-done') this.transcript(event);
      });
      this.peer = peer;
      if (mode === 'duplex') peer.muteMic(this.muted);
      peer.muteSpeaker(this.silent);
      // Submit capture intent while this same click is active. The Host waits
      // for its matching preparation before creating the media document.
      const [identity] = await Promise.all([preparation, peer.connect(mode === 'receive_only' ? mode : undefined)]);
      if (!this.current(generation)) { await peer.close(); return; }
      if (identity.phase !== 'ready') throw { code: 'unavailable' };
      if (mode === 'receive_only' && !identity.audio?.supportedModes?.includes(mode)) throw { code: 'unavailable' };
      this.identity = identity;
      this.show(this.message);
    } catch (error) {
      if (this.current(generation)) await this.end(explainError(error), true);
    }
  }
  async releaseLocal(message) {
    this.active = false;
    this.expectedHostStop = undefined;
    if (this.callId) this.retiredCallId = this.callId;
    ++this.generation;
    this.pendingText = undefined;
    clearTimeout(this.deadline);
    const peer = this.peer;
    this.peer = undefined;
    const releasedMode = this.audioMode;
    this.audioMode = null;
    this.retryMode = this.failed ? releasedMode : null;
    this.phase = 'idle';
    this.recovering = false;
    this.callId = null;
    this.show(message);
    await Promise.allSettled([peer?.close(), this.stopScreen()]);
  }
  async end(message, failed = false) {
    if (this.stopping) return this.stopping;
    const receiveOnly = this.audioMode === 'receive_only';
    message ??= this.stoppedMessage();
    this.failed = failed;
    const local = this.releaseLocal(message);
    const operation = Promise.all([local, this.client.stop()]);
    this.stopping = operation;
    try { await operation; }
    catch { this.show(receiveOnly ? '麦克风未启用 · 连接收尾尚未确认' : '麦克风已关闭 · 连接收尾尚未确认'); }
    finally { if (this.stopping === operation) this.stopping = undefined; }
  }
  async hostStopped(reason) {
    // Stop echoes must not erase a more useful local failure or manual ending.
    if (!this.active) return;
    if (reason === 'revoked' && this.expectedHostStop?.generation === this.generation) {
      this.expectedHostStop = undefined;
      this.failed = false;
      await this.releaseLocal(this.stoppedMessage());
      return;
    }
    const receiveOnly = this.audioMode === 'receive_only';
    const messages = receiveOnly ? {
      locked: '屏幕已锁定 · 只听已停止，解锁后可点击只听继续',
      suspended: '电脑已休眠 · 只听已停止，可点击只听继续',
      hidden: '猫猫已收起 · 只听已停止',
    } : {
      locked: '屏幕已锁定 · 语音通话已停止，解锁后可点击语音通话继续',
      suspended: '电脑已休眠 · 语音通话已停止，可点击语音通话继续',
      hidden: '猫猫已收起 · 语音通话已停止',
    };
    this.failed = !Object.hasOwn(messages, reason);
    await this.releaseLocal(messages[reason] ?? (receiveOnly
      ? '只听连接已中断 · 麦克风未启用，点击只听重试'
      : '语音通话已中断 · 麦克风已关闭，点击语音通话重试'));
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const identity = await this.client.state();
      if (generation !== this.generation) return;
      this.identity = identity;
      if (this.active && identity.audio?.activeMode) this.audioMode = identity.audio.activeMode;
      if (this.active && ['closed', 'failed', 'idle'].includes(identity.phase)) {
        if (this.expectedHostStop?.generation === this.generation) {
          this.expectedHostStop = undefined;
          this.failed = false;
          await this.releaseLocal(this.stoppedMessage());
        } else await this.end(this.retrying('语音连接已中断'), true);
      } else {
        if (this.expectedHostStop?.generation === this.generation && !this.expectedHostStop.pending)
          this.expectedHostStop = undefined;
        this.show(this.message ?? '点击语音通话，直接对我说话');
      }
    } catch (error) {
      if (generation === this.generation) {
        if (this.active) await this.end(explainError(error), true);
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
      this.show(allowed ? '资料查询已开启 · 点击语音通话继续' : '资料查询已暂停 · 点击语音通话继续');
    } catch (error) { this.show(explainError(error)); }
    finally { this.changingDocuments = false; }
  }
  async send(text) {
    text = text.trim();
    if (!text || !this.identity || this.phase === 'connecting' || this.stopping || this.sending) return false;
    if (!this.pendingText || this.pendingText.text !== text) this.pendingText = { text, id: this.uuid() };
    const input = this.pendingText;
    const generation = this.generation;
    this.sending = true;
    try {
      const receipt = await this.client.text(input.text, input.id);
      if (receipt?.delivery !== 'accepted') {
        if (generation === this.generation) this.show(explainError({ code: 'unconfirmed' }));
        return false;
      }
      if (this.pendingText === input) this.pendingText = undefined;
      // Voice may have ended; an accepted message still retires this draft.
      // Keep the newer voice status rather than announcing that we are listening.
      if (generation !== this.generation) return true;
      this.transcript({ type: 'typed', role: 'user', text, receipt });
      this.show(this.active ? this.listening() : '已发送 · 回答会留在同一段聊天中');
      return true;
    } catch (error) {
      if (generation === this.generation) this.show(explainError(error));
      return false;
    } finally { this.sending = false; }
  }
  muteMic() {
    if (this.audioMode === 'receive_only') return;
    this.muted = !this.muted; this.peer?.muteMic(this.muted);
    this.show(this.phase === 'talking' ? this.listening() : this.message);
  }
  muteSpeaker() { this.silent = !this.silent; this.peer?.muteSpeaker(this.silent); this.show(this.message); }
}
