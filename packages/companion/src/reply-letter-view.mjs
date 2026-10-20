const phaseLabel = phase => ({
  processing: '正在回复',
  failed: '回复失败',
  interrupted: '回复中断',
  canceled: '回复已取消',
  withdrawn: '回复已撤回',
}[phase] ?? '已发送');

const draftStatus = settlement => ({
  unconfirmed: '发送结果未确认',
  scope_changed: '原聊天已变化 · 这条消息没有重发',
  pending_limit: '待确认消息已达 32 条 · 这条没有发送',
  draft_changed: '草稿已在别处变化 · 请核对后再发送',
  unsupported_draft: '当前草稿含附件或过长 · 请回 Cat Café 继续编辑',
  conflict: '草稿已在别处变化 · 本地输入仍保留',
  readonly: '当前草稿含附件或过长 · 请回 Cat Café 继续编辑',
  permission_required: '聊天权限已撤销 · 本地输入仍保留',
  unavailable: '草稿暂未同步 · 本地输入仍保留',
}[settlement] ?? '');

/** DOM projection for compose → sent letter → complete reply → retained history. */
export class ReplyLetterView {
  constructor({ document, controller, retry, schedule = setTimeout, cancel = clearTimeout }) {
    this.$ = id => document.getElementById(id);
    Object.assign(this, { controller, retry });
    this.schedule = (...args) => Reflect.apply(schedule, globalThis, args);
    this.cancel = (...args) => Reflect.apply(cancel, globalThis, args);
    this.bind();
  }

  bind() {
    const card = this.$('reply-card');
    card.addEventListener('pointerenter', () => this.controller.pause('hover'));
    card.addEventListener('pointerleave', () => this.controller.resume('hover'));
    card.addEventListener('focusin', () => this.controller.pause('focus'));
    card.addEventListener('focusout', event => {
      if (!event.relatedTarget || !card.contains?.(event.relatedTarget)) this.controller.resume('focus');
    });
    const pauseScroll = () => {
      this.controller.pause('scroll');
      if (this.scrollTimer !== undefined) this.cancel(this.scrollTimer);
      this.scrollTimer = this.schedule(() => {
        this.scrollTimer = undefined;
        this.controller.resume('scroll');
      }, 500);
      this.scrollTimer?.unref?.();
    };
    card.addEventListener('wheel', pauseScroll);
    card.addEventListener('scroll', pauseScroll);
    card.addEventListener('pointerdown', () => this.controller.pause('pointer'));
    card.addEventListener('pointerup', () => this.controller.resume('pointer'));
    card.addEventListener('pointercancel', () => this.controller.resume('pointer'));
    this.$('reply-retain').onclick = () => this.controller.pin();
    this.$('reply-close').onclick = () => this.controller.close();
    this.$('reply-history-open').onclick = () => this.controller.openReplyHistory();
    this.$('reply-return-latest').onclick = () => this.controller.returnLatest();
    this.$('reply-retry').onclick = () => { if (this.value?.draft) this.retry(this.value.draft); };
  }

  render(value) {
    this.value = value;
    const history = value.mode === 'history';
    const replyHistory = history && value.historyPresentation === 'reply';
    const conversationHistory = history && !replyHistory;
    const compose = value.mode === 'compose' || conversationHistory;
    this.$('compose').hidden = !compose;
    this.$('chat-history-header').hidden = !conversationHistory;
    this.$('chat-name').hidden = replyHistory;
    this.$('chat-history-dismiss').hidden = replyHistory;
    this.$('reply-history-close').hidden = !replyHistory;
    this.$('chat-transcript-shell').hidden = !history;
    this.$('chat-transcript-shell').dataset.hasNewer = String(history && value.hasNewer);
    this.$('chat-transcript').hidden = !history;
    this.$('chat-scope').hidden = !conversationHistory;
    this.$('chat-connection-status').hidden = replyHistory;
    this.$('reply-sent').hidden = value.mode !== 'sent';
    this.$('reply-card').hidden = value.mode !== 'reply';
    this.$('reply-return-latest').hidden = !history || !value.hasNewer;

    const retrying = value.mode === 'compose' && value.draft?.settlement === 'unconfirmed';
    this.$('reply-retry').hidden = !retrying;
    const feedback = value.draft ? draftStatus(value.draft.settlement)
      : value.draftNotice ? draftStatus(value.draftNotice)
      : value.blockedReason === 'permission_required' ? '聊天权限已撤销' : '';
    this.$('chat-status').textContent = feedback;
    this.$('chat-feedback').hidden = !compose || (!feedback && !retrying);
    if (value.draft) {
      const input = this.$('message');
      if (!input.value || input.value === this.lastRenderedDraft) input.value = value.draft.text;
      this.lastRenderedDraft = value.draft.text;
    }

    if (value.letter) {
      this.$('reply-letter-text').textContent = '';
      this.$('reply-letter-text').hidden = true;
      this.$('reply-input-text').textContent = value.letter.text;
      this.$('reply-sent-status').textContent = phaseLabel(value.letter.responsePhase);
    }
    if (value.reply) {
      this.$('reply-body').textContent = value.reply.text;
      this.$('reply-body-status').textContent = value.reply.complete ? '' : '正在载入完整回复…';
    } else {
      this.$('reply-body').textContent = '';
      this.$('reply-body-status').textContent = '';
    }

    const canRetain = value.mode === 'reply' && value.reply?.complete === true && !value.retained;
    this.$('reply-retain').hidden = !canRetain;
    this.$('reply-close').hidden = value.mode !== 'reply' || !value.retained;
    this.$('reply-retain').dataset.running = String(canRetain && value.timer.running);
    this.$('reply-retain').style.setProperty('--reply-visible-ms', `${value.timer.remainingMs}ms`);
    this.$('chat').dataset.replyMode = value.mode;
    this.$('chat').dataset.historyPresentation = history
      ? value.historyPresentation ?? 'conversation' : '';
  }
}
