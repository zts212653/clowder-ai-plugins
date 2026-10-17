const el = (id) => document.getElementById(id);
let validPage = false,
  state;
const mode = () => document.querySelector('input[name=mode]:checked').value;
const messages = {
  HELPER_UNAVAILABLE:
    '本机组件没有响应。请回到 Cat Café，让猫通过 Tripo 插件准备或修复本机组件，再点「刷新状态」。连接恢复前，生成任务暂停，不会提交。',
  HELPER_VERSION_MISMATCH:
    '本机组件需升级，扩展待重载。请让猫修复本机组件，再加载返回的扩展目录并重新授权。',
  HELPER_NOT_READY: '本机组件尚未连接完成，请点「刷新状态」。',
  OPEN_1_TO_8_MODEL_PAGES: '请打开 1–8 个 Tripo 模型页后重试。',
};
function render() {
  const write = mode() === 'workspace',
    count = state?.authorized?.length ?? 0;
  const authorized = write ? state?.workspaceAuthorized : count > 0;
  el('read-description').hidden = write;
  el('workspace-description').hidden = !write;
  el('grant').textContent = write ? '授权生成与导出' : '授权读取 Tripo Studio';
  el('grant').hidden = !!authorized;
  el('grant').disabled = !validPage;
  el('revoke').hidden = !authorized;
  el('status').textContent = write
    ? authorized
      ? '生成与导出 · 已授权'
      : '生成与导出 · 未授权。当前只能读取；要提交生成，请在此授权。'
    : count
      ? `已授权 ${count} 个模型页${state.lastRead ? ` · 最近读取 ${state.lastRead.count} 个候选` : ' · 尚未读取'}`
      : '尚未授权';
  el('downgrade').hidden = !write;
  el('revoke-description').textContent = write
    ? '撤销将关闭插件新建的工作页，不会取消已经提交到 Tripo 的生成，已取回的文件也会保留。'
    : '撤销后，猫无法再读取 Tripo Studio。已存到本机的模型文件会保留。';
  el('task-status').textContent =
    state?.lastSubmission?.state === 'submission_unknown'
      ? '提交结果未知 · 未自动重试。为避免重复扣积分，请先在 Tripo 作品列表里核对这次生成。'
      : state?.lastSubmission?.state === 'submitted'
        ? '已提交 · 请在 Tripo 作品列表中核对生成状态。'
        : '';
}
async function refresh(op = 'status') {
  const result = await chrome.runtime.sendMessage({ op });
  if (result.error) throw new Error(messages[result.error] ?? result.error);
  state = result;
  el('connection').textContent = result.connected ? '已连接' : '未连接';
  el('error').textContent = result.lastError
    ? (messages[result.lastError] ?? messages.HELPER_UNAVAILABLE)
    : '';
  el('version').textContent =
    `本机组件 · ${result.connected ? '已连接' : '未连接'} · ${result.helperVersion ? `v${result.helperVersion}` : '版本未核实'}；扩展 v${result.version}`;
  render();
}
async function run(action) {
  try {
    await action();
  } catch (error) {
    el('error').textContent = error.message;
  }
}
for (const input of document.querySelectorAll('input[name=mode]'))
  input.onchange = render;
el('grant').onclick = () =>
  run(async () => {
    const write = mode() === 'workspace';
    const granted = await chrome.permissions.request({
      origins: ['https://studio.tripo3d.ai/*'],
      ...(write ? { permissions: ['downloads'] } : {}),
    });
    if (!granted)
      throw new Error(
        'Chrome 未允许访问，当前授权保持不变。需要时再点授权按钮。',
      );
    await refresh(write ? 'grant-workspace' : 'grant');
  });
el('revoke').onclick = () => {
  el('confirm').hidden = false;
  el('revoke').hidden = true;
};
el('cancel').onclick = () => {
  el('confirm').hidden = true;
  render();
};
el('downgrade').onclick = () =>
  run(async () => {
    await refresh('downgrade');
    el('confirm').hidden = true;
  });
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
el('page').textContent = validPage
  ? tab.url.replace('https://', '')
  : '此扩展只读取 studio.tripo3d.ai';
await run(() => refresh());
