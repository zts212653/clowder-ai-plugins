import { createCompanionClient } from './client.mjs';
import { CompanionConversation } from './conversation.mjs';
import { explainError } from './errors.mjs';
import { VoicePeer } from './peer.mjs';
import { ScreenShare } from './screen-share.mjs';
import { TranscriptView } from './transcript-view.mjs';
import { RecentBubble } from './recent-bubble.mjs';
import { PetMotion } from './pet-motion.mjs';
import { bindPetControls } from './pet-controls.mjs';
import { decisionBadge, decisionRows } from './decision-view.mjs';

const $ = id => document.getElementById(id);
const label = (id, text) => { $(id).querySelector('.label').textContent = text; };
const status = text => { $('status').textContent = text; $('chat-status').textContent = text; $('announcement').textContent = text; };
const transcript = new TranscriptView($('transcript'));
const bubble = new RecentBubble([$('bubble-first'), $('bubble-second')]);
const motion = new PetMotion($('pet'));
let sharing = false, pendingScreen = false, loading = false, latestHistory, previousPhase = 'idle';
let decisionLoading = false, decisionOffset = 0;
let threadTitle;

if (!window.clowderCompanion) {
  $('actions').hidden = false; $('status').hidden = false;
  status('请从 Clowder 的聊聊入口打开猫猫球');
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
} else {
  const client = createCompanionClient(window.clowderCompanion);
  const controls = bindPetControls(client, {
    error: error => status(explainError(error)),
    moved: (dx, dy) => dx === 'stop' ? motion.stopMove() : motion.move(dx, dy),
    changed: panel => { if (panel === 'chat') void readHistory(); if (panel === 'decisions') void readDecisions(); },
    action(kind) {
      if (kind === 'begin') { transcript.reset(); bubble.reset(); void conversation.begin(); void controls.show('none'); }
      if (kind === 'stop') void conversation.end();
      if (kind === 'mute') conversation.muteMic();
      if (kind === 'speaker') conversation.muteSpeaker();
      if (kind === 'share') toggleScreen();
      if (kind === 'documents') void conversation.documents(conversation.identity?.documentsAllowed === false);
      if (kind === 'hide') void client.hide().catch(error => status(explainError(error)));
    },
  });
  const screen = new ScreenShare({
    screenRequest: () => client.screenPick(),
    screenStart: (selectionId, name) => client.screenOpen(selectionId, name),
    screenFrame: (selectionId, frame) => client.screenFrame(selectionId, {
      ...frame, frameId: crypto.randomUUID(), sourceLabel: '所选画面', observedAt: Date.now(),
    }), screenStop: () => client.screenClose(),
  }, value => {
    sharing = value.sharing; pendingScreen = value.pending === true;
    for (const id of ['share', 'menu-share']) label(id, sharing ? '停止共享' : pendingScreen ? '取消选屏' : '共享画面');
    $('share-badge').hidden = !sharing && !pendingScreen;
    $('share-badge').title = sharing ? `正在共享：${value.label}，点此停止` : '正在选屏，点此取消';
  });
  function toggleScreen() {
    if (conversation.phase !== 'talking') {
      status('先点语音聊，连上后可选择窗口或屏幕');
      $('status').hidden = false;
      void controls.show('actions');
      return;
    }
    void (sharing || pendingScreen ? screen.stop('屏幕共享已停止') : screen.start()).catch(error => status(explainError(error)));
  }
  const conversation = new CompanionConversation({
    client, createPeer: callback => new VoicePeer(callback, client), stopScreen: () => screen.stop(),
    transcript: event => {
      if (event.type === 'turn-done') { transcript.finish(event); bubble.finish(event.role); if (event.role === 'assistant') motion.signal('answered'); void readHistory(); }
      else if (event.typed) void readHistory();
      else { transcript.append(event.role, event.text, true); bubble.append(event.role, event.text); void controls.setAmbient(true); }
    },
    render(value) {
      const showFailure = value.failed && previousPhase !== 'idle' && value.phase === 'idle';
      const justConnected = previousPhase !== 'talking' && value.phase === 'talking';
      if (previousPhase !== 'idle' && value.phase === 'idle') { transcript.reset(); bubble.reset(); void readHistory(); }
      previousPhase = value.phase;
      const active = value.phase !== 'idle';
      void controls.setAmbient(active && bubble.hasContent());
      $('begin').hidden = active; $('begin').disabled = !value.identity;
      label('begin', value.failed ? '重试语音' : '语音聊');
      $('mic').hidden = value.phase !== 'talking'; $('speaker').hidden = !active;
      $('active-actions').hidden = !active;
      $('share').disabled = value.phase !== 'talking';
      $('compose').querySelector('button').disabled = !value.identity || value.phase === 'connecting';
      status(value.message ?? '');
      $('status').hidden = !value.message || /^(点|正在听|语音已结束|已发送)/.test(value.message);
      $('call-badge').hidden = !active;
      $('call-badge').dataset.state = value.muted ? 'muted' : value.phase;
      const callLabel = value.phase === 'connecting' ? '正在连接，点此取消' : value.muted ? '麦克风已静音，点此结束' : '语音进行中，点此结束';
      $('call-badge').title = callLabel; $('call-badge').setAttribute('aria-label', callLabel);
      label('mic', value.muted ? '取消静音' : '静音'); $('mic').setAttribute('aria-pressed', String(value.muted));
      label('speaker', value.silent ? '开启播音' : '关闭播音');
      const identity = value.identity;
      motion.setContext({ skin: identity?.skin, phase: value.phase, nativeActivity: identity?.nativeActivity ?? 'none', muted: value.muted });
      if (justConnected) motion.signal('connected');
      if (showFailure) motion.signal('failed');
      if (identity) {
        $('chat-name').textContent = threadTitle ?? identity.displayName; $('menu-name').textContent = identity.displayName;
        $('pet').setAttribute('aria-label', `${identity.displayName}：点击交流，右键更多，拖动移动`);
        $('documents').querySelector('.menu-status').textContent = identity.documentsAllowed ? '开启' : '暂停';
        $('documents').setAttribute('aria-pressed', String(identity.documentsAllowed));
        $('connection-scope').textContent = identity.duty.catId === identity.carrier.catId ? '交流保存在同一段聊天中' : `${identity.duty.displayName} · 实时语音由${identity.carrier.displayName}承载`;
      }
      if (showFailure) void controls.show('actions');
    },
  });
  async function readHistory() {
    if (loading || (controls.panel !== 'chat' && conversation.phase === 'idle')) return;
    loading = true;
    try {
      const history = await client.readConversation();
      $('history').textContent = history.hasMore ? '更早聊天 ↗' : '完整聊天 ↗';
      threadTitle = history.threadTitle;
      $('chat-name').textContent = threadTitle;
      bubble.load(history.messages);
      void controls.setAmbient(conversation.phase !== 'idle' && bubble.hasContent());
      const serialized = JSON.stringify(history.messages);
      if (serialized !== latestHistory) { latestHistory = serialized; transcript.load(history.messages); }
    } catch { $('chat-status').textContent = '聊天记录暂未更新 · 正在说的话仍会显示'; }
    finally { loading = false; }
  }
  function showDecisionBadge(page) {
    const badge = decisionBadge(page);
    $('pending-badge').hidden = !badge.visible;
    $('pending-count').textContent = badge.label;
    $('pending-badge').title = badge.title;
    $('pending-badge').setAttribute('aria-label', badge.title);
    $('menu-pending').textContent = badge.label;
  }
  async function readDecisions(more = false) {
    if (decisionLoading) return;
    decisionLoading = true;
    if (!more && controls.panel === 'decisions') $('decision-status').textContent = '正在读取待决事项…';
    try {
      const page = await client.readDecisions(more ? decisionOffset : 0, 10);
      if (page.status !== 'available') throw new Error('Decision source unavailable');
      showDecisionBadge(page);
      if (controls.panel !== 'decisions') return;
      const list = $('decision-list');
      if (!more) { list.replaceChildren(); list.scrollTop = 0; }
      for (const row of decisionRows(page)) {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        const meta = document.createElement('span');
        title.textContent = row.title; meta.textContent = row.meta;
        item.append(title, meta); list.append(item);
        if (row.previewable) {
          const button = document.createElement('button');
          button.type = 'button'; button.textContent = '查看确认演练';
          button.onclick = async () => {
            try {
              const result = await client.inspectF221(row.proposalId);
              $('decision-status').textContent = result.status === 'trial_confirmed'
                ? '确认演练已完成；没有写回提案'
                : result.status === 'stale' ? '提案已变化，请重新查看原处卡片'
                  : result.status === 'dismissed' ? '已取消演练；提案没有变化'
                    : '确认演练暂不可用；请在原处处理';
            } catch { $('decision-status').textContent = '确认演练暂不可用；请在原处处理'; }
          };
          item.append(button);
        }
      }
      decisionOffset = page.page.offset + page.page.limit;
      $('decision-status').textContent = page.approvalCount + page.otherNeedsMeCount === 0
        ? '现在没有待你处理的事项'
        : `${page.approvalCount} 项审批事项，另有 ${page.otherNeedsMeCount} 项待处理`;
      $('decision-more').hidden = !page.page.hasMoreApprovals && !page.page.hasMoreNeedsMe;
    } catch {
      showDecisionBadge(undefined);
      if (controls.panel === 'decisions') $('decision-status').textContent = '待决事项暂不可读 · 请稍后刷新';
    } finally { decisionLoading = false; }
  }
  $('call-badge').onclick = () => void conversation.end();
  $('share-badge').onclick = toggleScreen;
  $('pending-badge').onclick = () => void controls.show('decisions');
  $('decision-reload').onclick = () => void readDecisions();
  $('decision-more').onclick = () => void readDecisions(true);
  $('history').onclick = () => void client.openConversation().then(result => {
    if (result.delivery === 'unconfirmed') status('打开聊天尚未确认 · 请从 Clowder 查看');
  }).catch(error => status(explainError(error)));
  $('compose').onsubmit = async event => {
    event.preventDefault(); const text = $('message').value;
    if (await conversation.send(text)) {
      motion.signal('received');
      if ($('message').value === text) $('message').value = '';
      latestHistory = undefined; void readHistory();
    }
  };
  const unsubscribe = client.subscribe(event => {
    if (event.kind === 'media-stopped') void conversation.hostStopped(event.reason);
    if (event.kind === 'view-dismiss') controls.dismiss();
  });
  const statusMonitor = setInterval(() => void conversation.refresh(), 1000);
  const historyMonitor = setInterval(() => void readHistory(), 3000);
  const decisionMonitor = setInterval(() => { if (controls.panel !== 'decisions') void readDecisions(); }, 15000);
  void conversation.refresh(); void readDecisions(); void controls.show('none');
  window.addEventListener('beforeunload', () => {
    clearInterval(statusMonitor); clearInterval(historyMonitor); clearInterval(decisionMonitor);
    unsubscribe(); motion.close(); void conversation.end();
  });
}
