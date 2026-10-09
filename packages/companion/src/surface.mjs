import { createCompanionClient } from './client.mjs';
import { CompanionConversation } from './conversation.mjs';
import { explainError } from './errors.mjs';
import { VoicePeer } from './peer.mjs';
import { ScreenShare } from './screen-share.mjs';
import { TranscriptView } from './transcript-view.mjs';
import { CallTranscriptView } from './call-transcript-view.mjs';
import { SettingsView } from './settings-view.mjs';
import { RecentBubble } from './recent-bubble.mjs';
import { PetMotion } from './pet-motion.mjs';
import { LivingBody } from './living-body.mjs';
import { detectDockedEdge } from './living-edge.mjs';
import { bindPetControls } from './pet-controls.mjs';
import { DecisionPanel } from './decision-panel.mjs';
import { nativeWorkLabel, normalizeNativeWork } from './native-work-motion.mjs';
import { NativeWindowTravel } from './native-window-travel.mjs';
import { currentCompanionIdentity } from './companion-identity.mjs';
import { FoldedChatUnread } from './chat-unread.mjs';
import { COMPACT_BALL_SIZE, compactSizeAction } from './compact-size.mjs';
import { WorkOverviewView } from './work-overview.mjs';
const $ = id => document.getElementById(id);
const label = (id, text) => { $(id).querySelector('.label').textContent = text; };
const status = text => {
  $('status').textContent = text;
  $('menu-status').textContent = text;
  $('chat-status').textContent = text;
  $('announcement').textContent = text;
};
const transcript = new TranscriptView($('chat-transcript'));
const callTranscript = new CallTranscriptView($('call-transcript-log'), {
  onUnread: count => {
    $('call-unread').hidden = count === 0;
    $('call-unread').textContent = count ? `${count} 条新消息` : '';
  },
});
const bubble = new RecentBubble([$('bubble-first'), $('bubble-second')]);
const callBubble = new RecentBubble([$('call-bubble-first'), $('call-bubble-second')]);
const foldedChatUnread = new FoldedChatUnread(count => {
  $('call-chat-unread').hidden = count === 0;
  $('call-chat-unread').textContent = count ? String(count) : '';
  $('call-chat').setAttribute('aria-label', count ? `聊天，${count} 条未读` : '聊天');
});
const motion = new PetMotion($('pet'), { livingBody: new LivingBody({ root: $('pet'), sit: $('living-sit'),
  video: $('living-video'), transitionVideo: $('living-video-transition') }) });
const nativeTravel = new NativeWindowTravel({
  readPosition: () => ({ x: window.screenX, y: window.screenY }),
  changed: value => motion.syncTravel(value),
});
let sharing = false, pendingScreen = false, loading = false, transcriptLoading = false, latestHistory, previousPhase = 'idle';
let didMove = false, threadTitle, settingsView, settingsValues, decisionPanel, workView;
let previousControlPanel = 'none';
// F229 stays quiet: a history ID change has no provenance for proactive text.
const ambientPanel = active => active ? 'actions' : 'none';
const setTexts = (ids, text) => { for (const id of ids) $(id).textContent = text; };
const setHidden = (ids, hidden) => { for (const id of ids) $(id).hidden = hidden; };
if (!window.clowderCompanion) {
  $('actions').hidden = false; $('status').hidden = false;
  status('请从 Clowder 的聊聊入口打开猫猫球');
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
} else {
  nativeTravel.start();
  const client = createCompanionClient(window.clowderCompanion);
  const controls = bindPetControls(client, {
    error: (error, context) => status(context?.panel === 'settings' && error?.code === 'invalid_request' ? '这个 Host 版本还不支持猫旁设置。原来的设置入口会继续保留。' : explainError(error)),
    moved: (dx, dy) => {
      if (dx !== 'stop') { didMove = true; nativeTravel.setManual(true); motion.move(dx, dy); return; }
      nativeTravel.setManual(false);
      motion.stopMove();
      if (!didMove) return;
      didMove = false;
      void conversation.refresh();
      setTimeout(() => motion.setDockedEdge(detectDockedEdge(window, $('pet').getBoundingClientRect())), 100);
    },
    changed: panel => {
      if (panel === 'chat') foldedChatUnread.open();
      else if (previousControlPanel === 'chat' && conversation?.active) foldedChatUnread.fold();
      previousControlPanel = panel;
      if (panel === 'chat') void readHistory();
      if (panel === 'transcript') void readCallTranscript();
      if (panel === 'decisions') void decisionPanel?.read();
      if (panel === 'settings') void settingsView?.open();
      if (panel === 'menu') void workView?.load();
    },
    action(kind) {
      if (kind === 'begin') { transcript.reset(); callTranscript.reset(); bubble.reset(); callBubble.clear(); void conversation.begin(); void controls.show('none'); }
      if (kind === 'listen') { transcript.reset(); callTranscript.reset(); bubble.reset(); callBubble.clear(); void conversation.begin('receive_only'); void controls.show('none'); }
      if (kind === 'stop') void conversation.end();
      if (kind === 'mute') conversation.muteMic();
      if (kind === 'speaker') conversation.muteSpeaker();
      if (kind === 'share') toggleScreen();
      if (kind === 'documents') void conversation.documents(conversation.identity?.documentsAllowed === false);
      if (kind === 'hide') void client.hide().catch(error => status(explainError(error)));
      if (kind === 'size-toggle') {
        if (!settingsValues) { status('大小设置仍在读取'); return; }
        void settingsView.controller.requestUpdate('ballSize', compactSizeAction(settingsValues.ballSize).value);
      }
      if (kind === 'transcript-return') void controls.show('actions');
      if (kind === 'transcript-expand') {
        const expanded = $('transcript').dataset.expanded !== 'true';
        $('transcript').dataset.expanded = String(expanded);
        setTexts(['transcript-expand-label'], expanded ? '收起' : '展开');
        void controls.show('transcript');
      }
      if (kind === 'play' && conversation.identity?.skin === 'xianxian-codex') {
        void controls.show('none');
        motion.signal('play');
      }
    },
  });
  const screen = new ScreenShare({
    screenRequest: () => client.screenPick(),
    screenStart: (selectionId, name) => client.screenOpen(selectionId, name),
    screenFrame: (selectionId, frame) => client.screenFrame(selectionId, {
      ...frame, frameId: crypto.randomUUID(), sourceLabel: '所选画面', observedAt: Date.now(),
    }), screenStop: () => client.screenClose(),
  }, value => {
    const wasActive = sharing || pendingScreen;
    sharing = value.sharing; pendingScreen = value.pending === true;
    for (const id of ['share', 'menu-share', 'menu-call-share', 'chat-share', 'settings-share']) label(id, sharing ? '停止共享' : pendingScreen ? '取消选屏' : '共享画面');
    for (const prefix of ['call', 'menu', 'chat', 'transcript', 'settings']) {
      $(`${prefix}-share-context`).hidden = !sharing;
      $(`${prefix}-share-target`).textContent = sharing ? `共享中：${value.label}` : '';
    }
    $('share-badge').hidden = !sharing && !pendingScreen;
    $('share-badge').title = sharing ? `正在共享：${value.label}，点此停止` : '正在选屏，点此取消';
    $('share-badge').setAttribute('aria-label', sharing ? `停止共享：${value.label}` : '取消选屏');
    if (value.message && value.message !== '未共享屏幕' && (wasActive || pendingScreen)) status(value.message);
  });
  function toggleScreen() {
    if (conversation.phase !== 'talking') {
      status('先开始语音通话，连上后可选择窗口或屏幕');
      $('status').hidden = false;
      void controls.show('actions');
      return;
    }
    void (sharing || pendingScreen ? screen.stop('屏幕共享已停止') : screen.start()).catch(error => status(explainError(error)));
  }
  const conversation = new CompanionConversation({
    client, createPeer: callback => new VoicePeer(callback, client), stopScreen: () => screen.stop(),
    transcript: event => {
      if (event.type === 'turn-done') {
        transcript.finish(event); callTranscript.finish(event); bubble.finish(event.role); callBubble.finish(event.role);
        void readHistory(); void readCallTranscript();
      } else if (event.type === 'typed') {
        callTranscript.appendTyped(event);
        void readHistory(); void readCallTranscript();
      } else {
        transcript.append(event.role, event.text, true);
        callTranscript.appendLive(event);
        const speaker = event.role === 'assistant' ? conversation.identity?.displayName ?? '猫猫' : '语音';
        bubble.append(event.role, event.text, speaker); callBubble.append(event.role, event.text, speaker);
        void controls.setAmbient('actions');
      }
    },
    render(value) {
      const showFailure = value.failed && previousPhase !== 'idle' && value.phase === 'idle';
      const justConnected = previousPhase !== 'talking' && value.phase === 'talking';
      if (previousPhase !== 'idle' && value.phase === 'idle') {
        transcript.reset(); callTranscript.reset(); bubble.reset(); callBubble.clear(); void readHistory();
        foldedChatUnread.reset();
        if (controls.panel === 'transcript') void controls.show('menu');
      }
      previousPhase = value.phase;
      const active = value.phase !== 'idle';
      const receiveOnly = value.audioMode === 'receive_only';
      const canReceiveOnly = value.identity?.audio?.supportedModes?.includes('receive_only') === true;
      const retryReceiveOnly = value.failed && value.retryMode === 'receive_only' && canReceiveOnly;
      callTranscript.setCall(value.callId);
      void controls.setAmbient(ambientPanel(active));
      $('begin').hidden = active; $('begin').disabled = !value.identity;
      $('listen').hidden = active || !canReceiveOnly; $('listen').disabled = !value.identity;
      label('begin', value.failed && !retryReceiveOnly ? '重试语音通话' : '语音通话');
      label('listen', retryReceiveOnly ? '重试只听' : '只听');
      $('begin').className = retryReceiveOnly ? '' : 'primary';
      $('listen').className = retryReceiveOnly ? 'primary' : '';
      $('mic').hidden = value.phase !== 'talking' || receiveOnly; $('speaker').hidden = !active;
      $('chat-mic').hidden = value.phase !== 'talking' || receiveOnly;
      $('menu-mic').hidden = value.phase !== 'talking' || receiveOnly;
      $('transcript-mic').hidden = value.phase !== 'talking' || receiveOnly;
      $('settings-mic').hidden = value.phase !== 'talking' || receiveOnly;
      $('active-actions').hidden = !active;
      $('share').disabled = value.phase !== 'talking';
      $('menu-call-share').disabled = value.phase !== 'talking';
      $('compose').querySelector('button').disabled = !value.identity || value.phase === 'connecting';
      status(value.message ?? '');
      $('status').hidden = !value.message || /^(点击|正在听|只听模式|只听已结束|语音通话已结束|已发送)/.test(value.message);
      $('menu-status').hidden = !value.message;
      const callState = value.recovering ? '连接不稳定' : value.phase === 'connecting' ? '正在连接'
        : receiveOnly ? '只听中' : active ? '通话中' : '';
      const microphoneState = receiveOnly ? '麦克风未启用'
        : value.phase === 'connecting' ? '正在请求麦克风'
          : value.recovering ? `正在等待原连接恢复 · ${value.muted ? '麦克风已静音' : '麦克风已开启'}`
            : value.muted ? '麦克风已静音' : active ? '麦克风已开启' : '';
      for (const id of ['actions', 'chat-call-context', 'transcript-call-context', 'menu-call-context', 'settings-call-context']) $(id).dataset.connectionState = value.recovering ? 'recovering' : active ? 'connected' : 'idle';
      setTexts(['call-state', 'chat-call-state', 'transcript-call-state', 'menu-call-state', 'settings-call-state'], callState);
      setTexts(['call-mic-state', 'chat-call-mic-state', 'transcript-call-mic-state', 'menu-call-mic-state', 'settings-call-mic-state'], microphoneState);
      setHidden(['chat-call-context', 'transcript-call-context', 'menu-call-context', 'settings-call-context'], !active);
      label('mic', value.muted ? '取消静音' : '静音'); $('mic').setAttribute('aria-pressed', String(value.muted));
      $('mic').setAttribute('aria-label', value.muted ? '取消静音' : '静音');
      $('mic-icon').setAttribute('href', value.muted ? '#i-mic-off' : '#i-mic');
      $('chat-mic').textContent = value.muted ? '取消静音' : '静音';
      $('menu-mic').setAttribute('aria-label', value.muted ? '取消静音' : '静音');
      $('menu-mic').title = value.muted ? '取消静音' : '静音';
      $('menu-mic').setAttribute('aria-pressed', String(value.muted));
      $('menu-mic-icon').setAttribute('href', value.muted ? '#i-mic-off' : '#i-mic');
      $('settings-mic').textContent = value.muted ? '取消静音' : '静音';
      $('transcript-mic').setAttribute('aria-label', value.muted ? '取消静音' : '静音');
      $('transcript-mic').setAttribute('aria-pressed', String(value.muted));
      $('transcript-mic-icon').setAttribute('href', value.muted ? '#i-mic-off' : '#i-mic');
      label('speaker', '播音');
      $('speaker').setAttribute('aria-pressed', String(!value.silent));
      $('speaker').title = value.silent ? '开启播音' : '关闭播音';
      $('name-card-actions').hidden = active;
      $('menu-hide-label').textContent = active ? '结束通话并隐藏' : '隐藏';
      const identity = value.identity;
      const companionIdentity = currentCompanionIdentity(identity);
      const nativeSnapshot = normalizeNativeWork(identity?.nativeWork);
      const workLabel = nativeWorkLabel(nativeSnapshot, identity?.nativeActivity);
      const workState = workLabel ? `${identity.displayName}${workLabel}` : '';
      setTexts(['call-work', 'chat-call-work', 'transcript-call-work', 'menu-call-work', 'settings-call-work'], workState);
      setHidden(['call-work', 'chat-call-work', 'transcript-call-work', 'menu-call-work', 'settings-call-work'], !workState);
      motion.setContext({ skin: identity?.skin, phase: value.phase,
        nativeActivity: identity?.nativeActivity ?? 'none', muted: value.muted || receiveOnly });
      motion.setBehaviorEnabled(identity?.behaviorEnabled === true);
      motion.syncNativeSnapshot(nativeSnapshot);
      if (justConnected) motion.signal('connected');
      if (showFailure) motion.signal('failed');
      if (identity) {
        $('menu-play').hidden = identity.skin !== 'xianxian-codex';
        const companionLabel = companionIdentity
          ? `${companionIdentity.title} · ${companionIdentity.partnerLabel}` : identity.displayName;
        $('chat-name').textContent = threadTitle ?? companionLabel; $('menu-name').textContent = companionLabel;
        $('call-message').placeholder = `发消息给${identity.displayName}…`;
        $('pet').setAttribute('aria-label', `${companionLabel}：点击或右键打开名片，拖动移动`);
        $('documents').querySelector('.menu-status').textContent = identity.documentsAllowed ? '开启' : '暂停';
        $('documents').setAttribute('aria-pressed', String(identity.documentsAllowed));
        if (companionIdentity) {
          $('connection-scope').textContent = `${companionIdentity.partnerLabel} · ${companionIdentity.liveLabel} · ${companionIdentity.deepLabel}`;
        } else {
          const live = identity.liveTransport?.kind === 'gpt_live_v3'
            ? 'GPT Live · 实时型号未证实' : '实时载体未确认';
          $('connection-scope').textContent = identity.duty.catId === identity.carrier.catId
            ? `${identity.duty.displayName} · ${live}`
            : `${identity.duty.displayName} · ${live} · 绑定载体 ${identity.carrier.displayName}`;
        }
      }
      if (showFailure) void controls.show('menu');
    },
  });
  settingsView = new SettingsView({
    document,
    client,
    close: () => void controls.show('menu'),
    callActive: () => conversation.active,
    expectHostStop: () => conversation.expectHostStop(),
    settleExpectedHostStop: callStopped => conversation.settleExpectedHostStop(callStopped),
    layoutChanged: () => { if (controls.panel === 'settings') controls.remeasure?.(); },
    onValues(values) {
      const sizeChanged = settingsValues !== undefined && settingsValues.ballSize !== values.ballSize;
      settingsValues = values;
      document.documentElement?.style?.setProperty?.('--pet-scale', String(values.ballSize / 72));
      $('anchor').dataset.ballSize = String(values.ballSize);
      $('anchor').dataset.compact = String(values.ballSize <= COMPACT_BALL_SIZE);
      label('menu-size-toggle', compactSizeAction(values.ballSize).label);
      motion.setBehaviorEnabled(values.behaviorEnabled);
      $('documents').hidden = true;
      decisionPanel?.refreshBadge();
      if (sizeChanged) void controls.show(controls.panel);
    },
  });
  workView = new WorkOverviewView({
    document,
    client,
    changed: () => { if (controls.panel === 'menu') controls.remeasure?.(); },
  });
  decisionPanel = new DecisionPanel({
    document,
    client,
    controls,
    motion,
    proactivePolicy: () => settingsValues?.proactivePolicy,
  });
  async function readHistory() {
    if (loading) return;
    loading = true;
    try {
      const history = await client.readConversation();
      $('history').textContent = history.hasMore ? '在 Cat Café 中查看更早聊天 ↗' : '在 Cat Café 中查看完整聊天 ↗';
      threadTitle = history.threadTitle;
      $('chat-name').textContent = threadTitle;
      bubble.load(history.messages);
      void controls.setAmbient(ambientPanel(conversation.phase !== 'idle'));
      const serialized = JSON.stringify(history.messages);
      if (serialized !== latestHistory) { latestHistory = serialized; transcript.load(history.messages); }
    } catch { $('chat-status').textContent = '聊天记录暂未更新 · 正在说的话仍会显示'; }
    finally { loading = false; }
  }
  async function readCallTranscript() {
    if (transcriptLoading || !conversation.active || !conversation.callId) return;
    transcriptLoading = true;
    const callId = conversation.callId;
    try {
      const reply = await client.readTranscript();
      if (!conversation.active || conversation.callId !== callId) return;
      callTranscript.load(reply);
      foldedChatUnread.receiveMany(reply.rows);
      callBubble.loadTranscript(reply.rows, conversation.identity?.displayName);
      $('call-transcript-status').textContent = reply.hasMore ? '这里只显示这次通话最近的内容' : '';
    } catch {
      if (conversation.active && conversation.callId === callId) $('call-transcript-status').textContent = '字幕暂未更新 · 实时内容仍会继续显示';
    } finally { transcriptLoading = false; }
  }
  $('share-badge').onclick = toggleScreen;
  $('history').onclick = () => void client.openConversation().then(result => {
    if (result.delivery === 'unconfirmed') status('打开聊天尚未确认 · 请从 Clowder 查看');
  }).catch(error => status(explainError(error)));
  async function submitMessage(event, inputId) {
    event.preventDefault(); const input = $(inputId); const text = input.value;
    if (await conversation.send(text)) {
      motion.signal('received');
      if (input.value === text) input.value = '';
      latestHistory = undefined; void readHistory();
    }
  }
  $('compose').onsubmit = event => submitMessage(event, 'message');
  $('call-compose').onsubmit = event => submitMessage(event, 'call-message');
  $('call-unread').onclick = () => callTranscript.scrollToBottom();
  const unsubscribe = client.subscribe(event => {
    if (event.kind === 'media-stopped') void conversation.hostStopped(event.reason);
    if (event.kind === 'view-dismiss') controls.dismiss();
  });
  const statusMonitor = setInterval(() => void conversation.refresh(), 1000);
  const historyMonitor = setInterval(() => void readHistory(), 3000);
  const transcriptMonitor = setInterval(() => void readCallTranscript(), 1000);
  const decisionMonitor = setInterval(() => { if (controls.panel !== 'decisions') void decisionPanel.read(); }, 15000);
  const workMonitor = setInterval(() => { if (controls.panel === 'menu') void workView.load(); }, 15000);
  void conversation.refresh(); void readHistory(); void decisionPanel.read(); void settingsView.controller.load(); void controls.show('none');
  window.addEventListener('beforeunload', () => {
    clearInterval(statusMonitor); clearInterval(historyMonitor); clearInterval(transcriptMonitor); clearInterval(decisionMonitor); clearInterval(workMonitor);
    unsubscribe(); nativeTravel.close(); motion.close(); void conversation.end();
  });
}
