import { explainError } from './errors.mjs';
import { ConversationHistory } from './conversation-history.mjs';
import { HostConversationDraft } from './conversation-draft.mjs';
import { ReplyLetterController } from './reply-letter-controller.mjs';
import { ReplyLetterView } from './reply-letter-view.mjs';

/** Owns the chat panel's history, durable draft and reply-letter interaction. */
export class ConversationSurface {
  constructor({ document, client, controls, bubble, transcript, getCallPhase,
    onAccepted, retryLegacy, status, scheduleInterval = setInterval,
    cancelInterval = clearInterval }) {
    this.$ = id => document.getElementById(id);
    Object.assign(this, { client, controls, bubble, transcript, getCallPhase,
      onAccepted, retryLegacy, status });
    this.scheduleInterval = (...args) => Reflect.apply(scheduleInterval, globalThis, args);
    this.cancelInterval = (...args) => Reflect.apply(cancelInterval, globalThis, args);
    this.activePageRead = null;
    this.pendingOlderRead = false;
    this.bodyReads = new Set();
    this.replyMode = 'idle';
    this.historySelection = null;
    this.controller = new ReplyLetterController({
      requestContinuation: value => void this.readBody(value.messageId, value.continuation),
      render: value => this.renderReply(value),
    });
    this.view = new ReplyLetterView({
      document,
      controller: this.controller,
      retry: draft => void (draft.submissionRevision === undefined
        ? this.retryLegacy(draft.text) : this.draft.retry(draft)),
    });
    this.lastRenderedDraft = '';
    this.draft = new HostConversationDraft({
      client,
      changed: value => this.renderDraft(value),
      delivery: value => {
        this.controller.recordDelivery(value.receipt, value.text, value);
        void this.readHistory();
      },
      invalidated: value => this.controller.invalidateDraft(value),
    });
    this.history = new ConversationHistory({ changed: value => this.renderHistory(value) });
    this.bind();
  }

  bind() {
    this.$('message').addEventListener('input', () => this.draft.update(this.$('message').value));
    this.$('history').onclick = () => void this.client.openConversation().then(result => {
      if (result.delivery === 'unconfirmed') this.status('打开聊天尚未确认 · 请从 Clowder 查看');
    }).catch(error => this.status(explainError(error)));
    this.$('reply-history-open').addEventListener('click', () => {
      void this.controls.show('chat');
      void this.readHistory();
    });
    this.$('reply-return-latest').addEventListener('click', () => {
      this.$('chat-transcript').scrollTop = this.$('chat-transcript').scrollHeight;
    });
    this.$('chat-transcript').addEventListener('scroll', () => {
      if (this.controller.mode === 'history' && this.$('chat-transcript').scrollTop < 24) {
        void this.readOlderHistory();
      }
    });
    this.$('chat-transcript').addEventListener('wheel', event => {
      if (event.deltaY < 0 && this.controller.mode === 'history'
        && this.$('chat-transcript').scrollTop <= 0) void this.readOlderHistory();
    }, { passive: true });
    this.$('compose').onsubmit = event => this.submit(event);
  }

  renderReply(value) {
    const previous = this.replyMode;
    const previousSelection = this.historySelection;
    if (previous === 'history' && value.mode !== 'history') {
      this.transcript.leaveHistory(previousSelection);
    }
    this.replyMode = value.mode;
    this.view.render(value);
    this.controls.remeasure?.();
    if (value.mode === 'history'
      && (previous !== 'history' || previousSelection !== value.selectedMessageId)) {
      this.transcript.enterHistory(value.selectedMessageId);
    }
    this.historySelection = value.mode === 'history' ? value.selectedMessageId : null;
    if (value.mode === 'reply' && previous !== 'reply' && this.controls.panel !== 'chat') {
      void this.controls.show('chat');
    }
    if (value.mode === 'idle' && previous === 'reply' && this.controls.panel === 'chat') {
      void this.controls.show('none');
    }
  }

  renderDraft(value) {
    const input = this.$('message');
    if (input.value !== this.lastRenderedDraft && input.value !== value.localText) {
      this.draft.update(input.value);
      return;
    }
    input.value = value.localText;
    this.lastRenderedDraft = value.localText;
    this.controller.setDraftNotice(value.status);
  }

  renderHistory(value) {
    this.threadTitle = value.threadTitle || this.threadTitle;
    if (this.threadTitle) this.$('chat-name').textContent = this.threadTitle;
    this.bubble.load(value.messages);
    this.transcript.load(value.messages);
    this.controller.loadHistory(value.messages);
    this.$('history').textContent = value.hasMoreOlder
      ? '在 Cat Café 中查看更早聊天 ↗' : '在 Cat Café 中查看完整聊天 ↗';
  }

  openWrite(callActive) {
    if (callActive) this.controller.openHistory();
    else this.controller.openCompose();
  }

  closeHistory() {
    if (this.controller.mode === 'history') this.controller.close();
  }

  openHistory() { this.controller.openHistory(); }

  async submit(event) {
    event.preventDefault();
    this.draft.update(this.$('message').value);
    const receipt = await this.draft.submit();
    if (receipt?.delivery !== 'accepted') return;
    this.onAccepted();
    void this.readHistory();
  }

  async readHistory({ before, older = false } = {}) {
    const readKind = older ? 'older' : 'latest';
    if (this.activePageRead) {
      if (readKind === 'older' && this.activePageRead === 'latest') this.pendingOlderRead = true;
      return;
    }
    this.activePageRead = readKind;
    try {
      const page = await this.client.readConversationPage(before === undefined ? {} : { before });
      this.history.loadPage(page, { older });
      void this.controls.setAmbient(this.getCallPhase() === 'idle' ? 'none' : 'actions');
      this.$('chat-connection-status').textContent = page.status === 'stale'
        ? '聊天位置已变化 · 请重新往上翻' : '';
    } catch (error) {
      if (error?.code === 'permission_required') {
        this.history.clearProtected('permission_required');
        this.controller.clearProtected('permission_required');
        this.$('chat-connection-status').textContent = '聊天权限已撤销';
      } else this.$('chat-connection-status').textContent = '聊天记录暂未更新 · 正在说的话仍会显示';
    } finally {
      const readPendingOlder = readKind === 'latest' && this.pendingOlderRead;
      if (readKind === 'latest') this.pendingOlderRead = false;
      this.activePageRead = null;
      if (readPendingOlder) void this.readOlderHistory();
    }
  }

  async readOlderHistory() {
    const { hasMoreOlder, olderCursor, pageStatus } = this.history.snapshot();
    if (this.controller.mode !== 'history' || pageStatus !== 'available' || !hasMoreOlder || !olderCursor) return;
    await this.readHistory({ before: olderCursor, older: true });
  }

  async readBody(messageId, continuation) {
    if (this.bodyReads.has(continuation) || this.history.bodyContinuation(messageId) !== continuation) return;
    this.bodyReads.add(continuation);
    try {
      const result = await this.client.readConversationBody(continuation);
      this.history.applyBody(continuation, result);
      if (result.status === 'stale') {
        this.controller.releaseContinuation(messageId, continuation);
        this.$('chat-connection-status').textContent = '回复正文已变化 · 正在重新读取';
        void this.readHistory();
      }
      if (result.status === 'withdrawn') this.controller.withdrawReply(messageId);
    } catch (error) {
      if (error?.code === 'permission_required') {
        this.history.clearProtected('permission_required');
        this.controller.clearProtected('permission_required');
        this.$('chat-connection-status').textContent = '聊天权限已撤销';
      } else {
        this.controller.releaseContinuation(messageId, continuation);
        this.$('chat-connection-status').textContent = '完整回复暂未读完 · 稍后重试';
      }
    } finally { this.bodyReads.delete(continuation); }
  }

  start() {
    void this.readHistory();
    void this.draft.load();
    this.historyMonitor = this.scheduleInterval(() => void this.readHistory(), 3000);
    this.draftMonitor = this.scheduleInterval(() => void this.draft.load(), 3000);
  }

  close() {
    this.cancelInterval(this.historyMonitor);
    this.cancelInterval(this.draftMonitor);
    this.draft.close();
  }
}
