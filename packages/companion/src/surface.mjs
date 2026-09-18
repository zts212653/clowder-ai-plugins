import { createCompanionClient } from './client.mjs';
import { CompanionConversation } from './conversation.mjs';
import { explainError } from './errors.mjs';
import { VoicePeer } from './peer.mjs';
import { ScreenShare } from './screen-share.mjs';
import { TranscriptView } from './transcript-view.mjs';

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const transcript = new TranscriptView($('transcript'));
let expanded = false;
let sharing = false;
let pendingScreen = false;

if (!window.clowderCompanion) {
  status('请从 Clowder 的插件页面打开猫猫球');
  for (const id of ['begin', 'documents', 'history']) $(id).disabled = true;
} else {
  const client = createCompanionClient(window.clowderCompanion);
  const screen = new ScreenShare({
    screenRequest: () => client.screenPick(),
    screenStart: (selectionId, label) => client.screenOpen(selectionId, label),
    screenFrame: (selectionId, frame) => client.screenFrame(selectionId, {
      ...frame, frameId: crypto.randomUUID(), sourceLabel: '所选画面', observedAt: Date.now(),
    }),
    screenStop: () => client.screenClose(),
  }, value => {
    sharing = value.sharing;
    pendingScreen = value.pending === true;
    $('share').textContent = sharing ? '停止共享' : pendingScreen ? '取消选屏' : '共享屏幕';
    $('share').setAttribute('aria-pressed', String(sharing));
    $('screen-status').hidden = !sharing && !pendingScreen && value.message === '未共享屏幕';
    $('screen-status').textContent = sharing ? `正在共享：${value.label}` : value.message;
    $('screen-status').dataset.state = sharing ? 'sharing' : pendingScreen ? 'pending' : 'stopped';
  });
  const conversation = new CompanionConversation({
    client, createPeer: callback => new VoicePeer(callback, client), stopScreen: () => screen.stop(),
    transcript: event => event.type === 'turn-done' ? transcript.finish(event) : transcript.append(event.role, event.text, !event.typed),
    render(value) {
      const active = value.phase !== 'idle';
      document.body.className = value.phase === 'talking' ? 'connected' : active ? 'connecting' : '';
      $('idle').hidden = active; $('controls').hidden = !active;
      $('share').hidden = value.phase !== 'talking';
      $('compose').querySelector('button').disabled = value.phase !== 'talking';
      $('begin').disabled = !value.identity;
      status(value.message);
      const identity = value.identity;
      if (identity) {
        $('identity').textContent = identity.displayName;
        $('chat-name').textContent = identity.displayName;
        $('pet').setAttribute('aria-label', `${identity.displayName}，拖动可以移动`);
        $('pet').dataset.skin = identity.skin;
        $('dock').setAttribute('aria-label', `和${identity.displayName}交流`);
        $('message').setAttribute('aria-label', `给${identity.displayName}写一句`);
        document.documentElement.style.setProperty('--speaker-label', JSON.stringify(identity.carrier.displayName));
        $('documents').textContent = `资料查询 · ${identity.documentsAllowed ? '开启' : '暂停'}`;
        $('documents').setAttribute('aria-pressed', String(identity.documentsAllowed));
        $('connection-scope').textContent = identity.duty.catId === identity.carrier.catId
          ? (active && identity.documentsAllowed ? `资料工具 · ${identity.toolsReady ? '已连接' : '连接中'}` : '交流保存在同一段聊天中')
          : `${identity.duty.displayName} · 实时语音由${identity.carrier.displayName}承载`;
      }
      for (const [id, muted, target, off, on] of [
        ['mic', value.muted, '麦克风', '取消静音', '静音'],
        ['speaker', value.silent, '播音', '开声音', '关声音'],
      ]) {
        $(id).setAttribute('aria-pressed', String(muted));
        $(id).setAttribute('aria-label', `${muted ? '开启' : '关闭'}${target}`);
        $(id).querySelector('span').textContent = muted ? off : on;
      }
    },
  });
  function details(value) {
    expanded = value;
    $('details').hidden = !value;
    $('write').setAttribute('aria-expanded', String(value));
    void client.resize(value).catch(error => status(explainError(error)));
  }
  $('begin').onclick = () => { transcript.reset(); void conversation.begin(); };
  $('end').onclick = () => void conversation.end();
  $('mic').onclick = () => conversation.muteMic();
  $('speaker').onclick = () => conversation.muteSpeaker();
  $('write').onclick = () => details(!expanded);
  $('collapse').onclick = () => details(false);
  $('share').onclick = () => void (sharing || pendingScreen ? screen.stop('屏幕共享已停止') : screen.start()).catch(() => status('屏幕共享已停止'));
  $('history').onclick = () => void client.openConversation().then(result => {
    if (result.delivery === 'unconfirmed') status('打开聊天尚未确认 · 请从 Clowder 查看猫猫球聊天');
  }).catch(error => status(explainError(error)));
  $('documents').onclick = () => void conversation.documents(conversation.identity?.documentsAllowed === false);
  $('compose').onsubmit = async event => {
    event.preventDefault();
    const text = $('message').value;
    if (await conversation.send(text)) {
      if ($('message').value === text) $('message').value = '';
    }
  };
  const unsubscribe = client.subscribe(event => {
    if (event.kind === 'media-stopped') void conversation.releaseLocal('语音已停止 · 点击开始聊天继续');
  });
  const monitor = setInterval(() => void conversation.refresh(), 3000);
  void conversation.refresh();
  window.addEventListener('beforeunload', () => {
    clearInterval(monitor); unsubscribe();
    void conversation.end();
  });
}
