window.createWechatKeychainRepair = ({ el, button, check, perform, show }) => {
  let operation, busy = false;
  const consent = check('我确认先暂停全部代聊并关闭连接组件；只在随后出现的 macOS 系统对话框输入钥匙串密码，重新授权已有加密库。');
  const firstSetup = check('我确认尝试完成首次初始化：仅在持久记录证明未曾发布账号数据，或已验证密文为空时继续；保留原库身份，不覆盖已有账号、密钥或历史。');
  const status = el('p', { class: 'muted', role: 'status' });
  const texts = {
    preparing: '已保存本次请求，正在停止代聊并核对组件', requesting: '请在 macOS 系统对话框确认或取消；最长等待两分钟',
    verified: '钥匙串授权与现有密文已核验。请另点“准备账号连接组件”，再明确恢复账号；不会自动恢复代聊。',
    initialized: '首次初始化已完成，原库身份已保留。请另点“准备账号连接组件”，然后明确扫码；没有恢复任何旧代聊。',
    already_initialized: '现有密文不是待初始化的空库，未执行首次初始化；请使用重新授权或核对原库。',
    cancelled: '本次系统授权已取消；原文件保持保留', unknown: '系统授权结果待核对；已保留原记录，不会自动再次打开系统对话框。可明确准备连接检查当前权限。',
    key_missing: '包装密钥条目不存在；不能用新密钥解开旧密文，原文件已保留',
    access_denied: '系统没有允许读取密钥；可在本人在场时重新明确授权',
    interaction_unavailable: '当前会话不能显示系统授权窗口。请在这台 Mac 的已登录桌面中操作。',
    authorization_not_persistent: '尚未确认持久访问许可；请重新明确授权，并在系统窗口选择“始终允许”（如提供）。',
    busy: '现有库仍被另一个进程占用；本次未修改原文件，请结束旧连接后再试',
    key_unavailable: '现有密钥仍不可用，原文件已保留',
    invalid_state: '现有账号库缺失、初始化未完成或未通过校验；重新授权不能重建它，原件已保留',
  };
  const start = button('解锁或重新授权钥匙串', async () => {
    if (!consent.input.checked) return show('请先确认系统授权范围。', true);
    busy = true; controls(); show('请只在刚才点击后出现的 macOS 系统对话框中确认或取消。');
    try { render(await perform({ action: 'reauthorize_keychain', confirm: true })); }
    finally { busy = false; consent.input.checked = false; controls(); }
  });
  const cancel = button('取消本次钥匙串操作', () => perform({ action: 'cancel_keychain_repair', operationId: operation?.operationId }));
  const initialize = button('完成中断的首次初始化', async () => {
    if (!firstSetup.input.checked) return show('请先确认首次初始化的恢复边界。', true);
    busy = true; controls();
    try { render(await perform({ action: 'recover_initialization', confirm: true })); }
    finally { busy = false; firstSetup.input.checked = false; controls(); }
  });
  function controls() {
    start.disabled = busy || !consent.input.checked || ['preparing', 'requesting'].includes(operation?.state);
    cancel.hidden = !['preparing', 'requesting'].includes(operation?.state);
    cancel.disabled = operation?.cancelRequested === true;
    initialize.disabled = busy || !firstSetup.input.checked || ['preparing', 'requesting'].includes(operation?.state);
  }
  consent.input.addEventListener('change', controls);
  firstSetup.input.addEventListener('change', controls);
  function render(value) {
    if (value) operation = value;
    status.textContent = texts[operation?.state] ?? '';
    if (operation?.systemAuthorizationMayHaveOccurred && operation.state !== 'verified') status.textContent += ' 系统可能已接受部分授权；停止本机进程不会撤销已经接受的系统许可。';
    controls();
  }
  controls();
  const node = el('details', { class: 'privacy' }, [el('summary', { text: '已有账号库打不开？解锁或重新授权钥匙串' }),
    el('p', { text: '升级后的程序可能需要系统重新确认访问。密码只进 macOS 系统窗口，不进入本面板、Host、模型或命令参数。正常启动和状态刷新不会弹窗；此操作不重建密钥、不删除原文件、不导入桌面微信。系统提示的确切措辞仍需本人现场核验。' }),
    consent.node, el('div', { class: 'toolbar' }, [start, cancel]), status,
    el('details', {}, [el('summary', { text: '只有首次初始化中断时' }),
      el('p', { text: '此入口同样可能显示 macOS 系统对话框。记录不完整、已发布的数据文件缺失、密钥丢失或密文损坏均不会按空库重建；没有足够证据时保留原件。' }), firstSetup.node, initialize])]);
  return { node, render };
};
