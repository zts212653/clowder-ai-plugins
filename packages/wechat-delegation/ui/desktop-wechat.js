window.createWechatDesktopStatus = ({ el, button, check, call, refresh }) => {
  const labels = {
    not_found: '没有找到本机官方微信', not_running: '官方微信已安装，当前没有运行',
    permission_required: '微信正在运行，登录状态待辅助功能授权后确认',
    logged_in_ui: '检测到已登录界面（应用菜单中的退出登录可用）',
    multiple_instances: '检测到多个微信实例，无法确认目标', unverified_app: '应用未通过腾讯签名核验，无法确认',
    unknown: '微信正在运行，但当前版本或菜单证据不足，无法确认登录', unsupported: '当前系统不支持桌面微信检测',
  };
  let checked = false, busy = false, generation = 0, current = null;
  const status = el('span', { class: 'badge', role: 'status', 'data-tone': 'idle', text: '尚未检查' });
  const evidence = el('small', { class: 'muted' });
  const consent = check('我同意向 macOS 申请辅助功能权限。本检测仅只读微信应用菜单，不读取聊天、账号名称或登录凭据。');
  const request = button('请求系统辅助功能授权', () => {
    if (!consent.input.checked) return;
    consent.input.checked = false; return inspect(true);
  });
  const recheck = button('重新检查本机微信', () => inspect(false));
  consent.input.addEventListener('change', () => { request.disabled = busy || !consent.input.checked; });
  const permission = el('div', { hidden: true }, [
    el('p', { class: 'muted', text: '辅助功能属于范围较大的系统权限。本检测只使用应用菜单；请按 macOS 的实际提示核对授权对象，完成后重新检查。授权不会接通插件或开启代聊。' }), consent.node, request]);
  const node = el('section', { class: 'notice', 'aria-label': '本机桌面微信状态' }, [
    el('div', { class: 'toolbar' }, [el('strong', { text: '本机桌面微信' }), status, recheck]), evidence, permission,
    el('p', { class: 'muted', text: '桌面微信状态与下面的插件连接分别核对。检测不会提取或导入桌面登录会话；也不会确认桌面账号与插件账号相同。' })]);
  function render(value) {
    current = value;
    status.textContent = busy ? '正在检查本机微信' : labels[value?.state] ?? '尚未检查';
    status.dataset.tone = !busy && value?.state === 'logged_in_ui' ? 'connected' : 'idle';
    evidence.textContent = value ? `依据：应用签名、进程${value.state === 'logged_in_ui' ? '与应用菜单' : ''}${value.appVersion ? ` · 微信 ${value.appVersion}` : ''} · ${new Date(value.observedAt).toLocaleTimeString()} 核对` : '';
    permission.hidden = value?.state !== 'permission_required';
    recheck.disabled = busy; request.disabled = busy || !consent.input.checked;
  }
  async function inspect(prompt) {
    if (busy) return;
    busy = checked = true; const observed = ++generation; render(current);
    try {
      const result = await call({ action: prompt ? 'desktop_request_access' : 'desktop_status', ...(prompt ? { confirm: true } : {}) });
      if (observed !== generation) return;
      busy = false; render(result); await refresh();
    } catch {
      if (observed !== generation) return;
      busy = false; render(null); status.textContent = '本次检测未完成，登录状态无法确认。';
    }
  }
  return { node, render(value) {
    if (value?.desktopWechat && !busy) render(value.desktopWechat);
    if (!checked) { checked = true; void inspect(false); }
  }, close() { generation++; } };
};
