const el = (id) => document.getElementById(id);
let validPage = false;
const messages = {
  HELPER_UNAVAILABLE: '本机组件没有响应。请回到 Cat Café，让猫通过 Tripo 插件准备或修复本机组件，再点「刷新状态」。',
  HELPER_VERSION_MISMATCH:
    '本机组件版本与扩展不一致。请让猫修复 Tripo 本机组件，然后在 Chrome 加载返回的新扩展目录并重新授权。',
  HELPER_NOT_READY: '本机组件尚未连接完成，请点「刷新状态」。',
  OPEN_1_TO_8_MODEL_PAGES: '请打开 1–8 个 Tripo 模型页后重试。',
};
async function refresh(op = 'status') {
  const result = await chrome.runtime.sendMessage({ op });
  if (result.error) throw new Error(messages[result.error] ?? result.error);
  el('connection').textContent = result.connected ? '已连接' : '未连接';
  el('error').textContent = result.lastError ? (messages[result.lastError] ?? messages.HELPER_UNAVAILABLE) : '';
  const count = result.authorized?.length ?? 0;
  el('status').textContent = count
    ? `已授权 ${count} 个模型页${result.lastRead ? ` · 最近读取 ${result.lastRead.count} 个候选` : ' · 尚未读取'}`
    : '尚未授权';
  el('grant').hidden = !!count;
  el('grant').disabled = !validPage;
  el('revoke').hidden = !count;
}
async function run(action) {
  try {
    await action();
  } catch (error) {
    el('error').textContent = error.message;
  }
}
el('grant').onclick = () =>
  run(async () => {
    const granted = await chrome.permissions.request({ origins: ['https://studio.tripo3d.ai/*'] });
    if (!granted) throw new Error('Chrome 未允许访问，猫仍无法读取。需要时再点「授权读取 Tripo Studio」。');
    await refresh('grant');
  });
el('revoke').onclick = () => {
  el('confirm').hidden = false;
  el('revoke').hidden = true;
};
el('cancel').onclick = () => {
  el('confirm').hidden = true;
  el('revoke').hidden = false;
};
el('revoke-confirm').onclick = () =>
  run(async () => {
    await refresh('revoke');
    el('confirm').hidden = true;
  });
el('refresh').onclick = () => run(() => refresh());
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
try {
  validPage = new URL(tab.url).origin === 'https://studio.tripo3d.ai';
} catch {}
el('page').textContent = validPage ? tab.url.replace('https://', '') : '此扩展只读取 studio.tripo3d.ai';
await run(() => refresh());
