import { createCompanionClient } from './client.mjs';
import { CompanionConversation } from './conversation.mjs';
import { explainError } from './errors.mjs';
import { VoicePeer } from './peer.mjs';
import { ScreenShare } from './screen-share.mjs';
import { TranscriptView } from './transcript-view.mjs';
import { bindPetControls } from './pet-controls.mjs';

const $ = id => document.getElementById(id);
const label = (id, text) => { $(id).querySelector('.label').textContent = text; };
const status = text => { $('status').textContent = text; $('chat-status').textContent = text; $('announcement').textContent = text; };
const transcript = new TranscriptView($('transcript'));
let sharing = false, pendingScreen = false, loading = false, latestHistory, previousPhase = 'idle';

if (!window.clowderCompanion) {
  $('actions').hidden = false; $('status').hidden = false;
  status('请从 Clowder 的聊聊入口打开猫猫球');
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
} else {
  const client = createCompanionClient(window.clowderCompanion);
  const controls = bindPetControls(client, {
    error: error => status(explainError(error)),
    changed: panel => { if (panel === 'chat') void readHistory(); },
    action(kind) {
      if (kind === 'begin') { transcript.reset(); void conversation.begin(); void controls.show('none'); }
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
    void (sharing || pendingScreen ? screen.stop('屏幕共享已停止') : screen.start()).catch(error => status(explainError(error)));
  }
  const conversation = new CompanionConversation({
    client, createPeer: callback => new VoicePeer(callback, client), stopScreen: () => screen.stop(),
    transcript: event => event.type === 'turn-done' ? transcript.finish(event) : transcript.append(event.role, event.text, !event.typed),
    render(value) {
      const showFailure = value.failed && previousPhase !== 'idle' && value.phase === 'idle';
      previousPhase = value.phase;
      const active = value.phase !== 'idle';
      $('begin').hidden = active; $('begin').disabled = !value.identity;
      label('begin', value.failed ? '重试语音' : '语音聊');
      $('mic').hidden = value.phase !== 'talking'; $('speaker').hidden = !active;
      $('active-actions').hidden = !active;
      for (const id of ['share', 'menu-share']) $(id).disabled = value.phase !== 'talking';
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
      if (identity) {
        $('chat-name').textContent = identity.displayName; $('menu-name').textContent = identity.displayName;
        $('pet').setAttribute('aria-label', `${identity.displayName}：点击交流，右键更多，拖动移动`);
        $('pet').dataset.skin = identity.skin;
        $('documents').querySelector('.menu-status').textContent = identity.documentsAllowed ? '开启' : '暂停';
        $('documents').setAttribute('aria-pressed', String(identity.documentsAllowed));
        $('connection-scope').textContent = identity.duty.catId === identity.carrier.catId ? '交流保存在同一段聊天中' : `${identity.duty.displayName} · 实时语音由${identity.carrier.displayName}承载`;
      }
      if (showFailure) void controls.show('actions');
    },
  });
  async function readHistory() {
    if (loading || conversation.active || controls.panel !== 'chat') return;
    loading = true;
    try {
      const history = await client.readConversation();
      if (conversation.active) return;
      $('history').textContent = history.hasMore ? '更早聊天 ↗' : '完整聊天 ↗';
      const serialized = JSON.stringify(history.messages);
      if (serialized !== latestHistory) { latestHistory = serialized; transcript.load(history.messages); }
    } catch (error) { status(explainError(error)); }
    finally { loading = false; }
  }
  $('call-badge').onclick = () => void conversation.end();
  $('share-badge').onclick = toggleScreen;
  $('history').onclick = () => void client.openConversation().then(result => {
    if (result.delivery === 'unconfirmed') status('打开聊天尚未确认 · 请从 Clowder 查看');
  }).catch(error => status(explainError(error)));
  $('compose').onsubmit = async event => {
    event.preventDefault(); const text = $('message').value;
    if (await conversation.send(text)) {
      if ($('message').value === text) $('message').value = '';
      latestHistory = undefined; void readHistory();
    }
  };
  const unsubscribe = client.subscribe(event => {
    if (event.kind === 'media-stopped') void conversation.releaseLocal('语音已停止');
    if (event.kind === 'view-dismiss') controls.dismiss();
  });
  const monitor = setInterval(() => { void conversation.refresh(); void readHistory(); }, 3000);
  void conversation.refresh(); void controls.show('none');
  window.addEventListener('beforeunload', () => { clearInterval(monitor); unsubscribe(); void conversation.end(); });
}
