import { createInteraction } from './interaction.mjs';

const $ = id => document.getElementById(id);
const pet = createInteraction();
const desktop = $('desktop');
const body = $('pet');
const anchor = $('anchor');
const label = (id, text) => { $(id).querySelector('.label').textContent = text; };
let connectionTimer;
let drag;
let suppressClick = false;
let renderedMessages;

function placePanel() {
  const panel = $(pet.state.panel);
  if (!panel || panel.hidden) return;
  const width = panel.offsetWidth, height = panel.offsetHeight;
  panel.style.left = `${Math.max(10, Math.min(anchor.offsetLeft + 60 - width / 2, desktop.clientWidth - width - 10))}px`;
  const above = anchor.offsetTop - height - 12;
  const top = above >= 10 ? above : anchor.offsetTop + anchor.offsetHeight + 10;
  panel.style.top = `${Math.max(10, Math.min(top, desktop.clientHeight - height - 10))}px`;
}

function render() {
  const s = pet.state;
  anchor.hidden = s.hidden;
  for (const id of ['actions', 'menu', 'chat']) $(id).hidden = s.panel !== id;
  body.setAttribute('aria-expanded', String(s.panel !== 'none'));
  const active = ['connecting', 'talking'].includes(s.call);
  $('begin').hidden = active;
  label('begin', s.call === 'failed' ? '重试语音' : '语音聊');
  $('active-actions').hidden = !active;
  $('mute').hidden = s.call !== 'talking';
  label('mute', s.muted ? '取消静音' : '静音');
  $('mute').setAttribute('aria-pressed', String(s.muted));
  $('share').disabled = s.call !== 'talking';
  $('menu-share').disabled = s.call !== 'talking';
  for (const id of ['share', 'menu-share']) label(id, s.sharing ? '停止共享' : '共享画面');
  $('documents').querySelector('.menu-status').textContent = s.documents ? '开启' : '暂停';
  $('documents').setAttribute('aria-pressed', String(s.documents));
  $('connection-error').hidden = s.call !== 'failed';
  const callText = s.call === 'connecting' ? '正在连接，点此取消' : s.muted ? '麦克风已静音，点此结束通话' : '语音进行中，点此结束';
  $('call-badge').hidden = !active;
  $('call-badge').title = callText;
  $('call-badge').setAttribute('aria-label', callText);
  $('call-badge').dataset.state = s.muted ? 'muted' : s.call;
  $('share-badge').hidden = !s.sharing;
  if ($('draft').value !== s.draft) $('draft').value = s.draft;
  if (renderedMessages !== s.messages) {
    renderedMessages = s.messages;
    if (s.messages.length) {
      $('messages').replaceChildren(...s.messages.map(message => {
        const p = document.createElement('p'); p.textContent = message.text; return p;
      }));
      $('messages').scrollTop = $('messages').scrollHeight;
    }
  }
  placePanel();
}

function act(type) {
  const before = pet.state;
  pet.dispatch({ type });
  if (type === 'begin' && before.call !== 'connecting' && pet.state.call === 'connecting') {
    clearTimeout(connectionTimer);
    const failed = $('fail').checked;
    connectionTimer = setTimeout(() => {
      pet.dispatch({ type: failed ? 'failed' : 'connected' }); render();
      $('announcement').textContent = failed ? '模拟连接失败，可以重试或写下来' : '模拟语音已连接，麦克风标记可直接结束';
    }, 900);
  }
  if (['stop', 'hide'].includes(type)) clearTimeout(connectionTimer);
  render();
  if (type === 'write') $('draft').focus();
  if (type === 'dismiss') body.focus({ preventScroll: true });
  if (type === 'send') $('announcement').textContent = '文字保留在这次预览中，没有发送给模型';
  if (type === 'stop') $('announcement').textContent = '模拟语音与共享均已停止';
}

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => act(button.dataset.action));
});
body.addEventListener('click', event => {
  if (suppressClick) { suppressClick = false; return; }
  if (event.detail > 1) return;
  act('tap');
});
body.addEventListener('contextmenu', event => {
  event.preventDefault(); act('menu'); $('menu').querySelector('button').focus();
});
body.addEventListener('keydown', event => {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault(); act('menu'); $('menu').querySelector('button').focus();
  }
});
body.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: anchor.offsetLeft, top: anchor.offsetTop, moved: false };
  body.setPointerCapture(event.pointerId);
});
body.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) { drag.moved = true; act('drag'); body.classList.add('dragging'); }
  anchor.style.left = `${Math.max(8, Math.min(drag.left + dx, desktop.clientWidth - 128))}px`;
  anchor.style.top = `${Math.max(8, Math.min(drag.top + dy, desktop.clientHeight - 138))}px`;
});
for (const type of ['pointerup', 'pointercancel']) body.addEventListener(type, () => {
  if (drag?.moved) suppressClick = true;
  drag = undefined; body.classList.remove('dragging');
});
desktop.addEventListener('pointerdown', event => {
  if (!event.target.closest('#anchor, .floating')) act('dismiss');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pet.state.panel !== 'none') { event.preventDefault(); act('dismiss'); }
});
$('call-badge').onclick = () => act('stop');
$('share-badge').onclick = () => act('share');
$('draft').oninput = event => pet.dispatch({ type: 'draft', text: event.target.value });
$('compose').onsubmit = event => { event.preventDefault(); act('send'); $('draft').focus(); };
$('restore').onclick = () => {
  act('restore'); anchor.style.left = 'calc(78% - 60px)'; anchor.style.top = 'calc(76% - 65px)';
};
$('instructions').onclick = () => { $('help').hidden = !$('help').hidden; };
$('theme').onclick = () => {
  const dark = desktop.classList.toggle('dark'); $('theme').textContent = dark ? '浅色背景' : '深色背景';
};
window.addEventListener('resize', () => {
  anchor.style.left = `${Math.max(8, Math.min(anchor.offsetLeft, desktop.clientWidth - 128))}px`;
  anchor.style.top = `${Math.max(8, Math.min(anchor.offsetTop, desktop.clientHeight - 138))}px`;
  placePanel();
});
render();
