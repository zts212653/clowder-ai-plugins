window.createWechatLoginLan = ({ el, button, check, authenticate }) => {
  let current;
  const consent = check('只允许本次登录：我同意临时监听并向微信上报本机私网地址和端口，同子网设备可取得本次验证数据。');
  const action = button('允许本次局域网验证', () => {
    if (!consent.input.checked) return;
    consent.input.checked = false; action.disabled = true;
    return authenticate('login_allow_lan', { operationId: current.operationId, confirm: true });
  });
  consent.input.addEventListener('change', () => { action.disabled = !consent.input.checked; });
  const status = el('p', { class: 'muted', role: 'status' });
  const node = el('aside', { class: 'notice', hidden: true, 'aria-label': '本次登录的局域网验证' }, [
    el('strong', { text: '微信要求本次局域网验证' }),
    el('p', { text: '确认后，组件仅在本机受支持的私有 IPv4 局域网接口监听一个 8050–8100 之间的 TCP 端口，最长 120 秒，并把这些地址与端口告知微信服务器。仅向同子网设备提供本次验证数据，最多处理 32 个连接，不读取对端内容。' }),
    el('p', { text: '系统不一定另行询问网络许可。取消、到期、登录完成或组件退出会结束监听；仍需按手机微信的提示完成登录，取得验证数据不会直接开启代聊。真实手机与网络兼容性仍待现场验收。' }),
    consent.node, action, status]);
  action.disabled = true;
  return { node, render(value) {
    if (current?.operationId !== value?.operationId) consent.input.checked = false;
    current = value;
    node.hidden = !['lan_awaiting_consent', 'lan_requesting', 'lan_verifying'].includes(value?.state) && !(value?.state === 'unknown' && value.lanConsentRequested);
    const waiting = value?.state === 'lan_awaiting_consent' && !value?.lanConsentRequested;
    consent.node.hidden = action.hidden = !waiting;
    action.disabled = !consent.input.checked || !waiting;
    status.textContent = waiting ? '尚未开启监听，也未上报局域网地址。只针对上面的原登录记录确认。' : value?.lanDeadlineAtMs ? `本次许可已记录，等待手机验证；记录的截止时间：${new Date(value.lanDeadlineAtMs).toLocaleTimeString()}。不会重新上报或延长。` : '本次许可结果仍待核对，只查询原操作，不重发许可。可以取消原操作后明确重新扫码。';
  } };
};
