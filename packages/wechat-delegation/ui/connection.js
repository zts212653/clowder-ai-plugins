window.createWechatConnection = ({ el, button, check, call, perform, show, refresh }) => {
  const ended = new Set(['idle', 'succeeded', 'failed', 'cancelled', 'interrupted', 'expired', 'rejected', 'lan_required']);
  const texts = {
    preparing: '正在保存本次认证意图', requesting: '正在建立本次认证操作', starting: '正在获取本次二维码',
    pending: '请用手机微信扫描本次二维码', scanned: '已扫码，请在手机微信确认', completing: '正在核验微信登录结果',
    authenticating: '正在恢复已保存的微信会话', succeeded: '账号身份已核验；代聊权限仍需逐会话开启',
    failed: '认证未完成；请核对原记录后再明确发起', expired: '本次二维码已过期，可以明确发起新的扫码',
    cancelled: '本次认证已取消', interrupted: '原认证已中断；记录已保留，不会自动重新认证',
    rejected: '手机微信未批准本次登录', lan_required: '微信要求局域网验证；当前入口尚未支持，本次未继续认证',
    cancel_requested: '已请求取消本次认证；正在核对原操作结果', unknown: '认证结果待核对；只查询原操作，不会自动重新认证',
  };
  let snapshot, current = { state: 'idle' }, timer, polling = false, version = 0, starting = false;
  const qr = el('div', { id: 'qr' }), authText = el('p', { role: 'status' }), operation = el('small', { class: 'muted auth-operation' });
  const uncertainty = el('p', { class: 'notice', hidden: true, text: '认证请求可能已经到达微信。取消或退出本机组件不能证明手机上的设备授权已撤销；请在手机微信核对已登录设备。' });
  const hint = el('p', { class: 'muted' }), sync = el('p', { role: 'status', class: 'muted' }), path = el('small');
  const consent = check('我了解将准备 Clowder 自有连接组件；登录后可能同步其他未选中会话到本机，猫只处理我另行授权的会话。');
  const setup = button('准备账号连接组件', async () => {
    if (!consent.input.checked) return show('请先阅读并确认客户端同步范围。', true);
    setup.disabled = true;
    try { await perform({ action: 'prepare', acceptThirdParty: true }, '连接组件已准备；请选择扫码或恢复已保存会话。'); }
    finally { setup.disabled = false; }
  }, 'primary');
  function schedule() {
    if (timer || snapshot?.runtime !== 'running' || ended.has(current.state)) return;
    timer = setInterval(async () => {
      if (polling || ended.has(current.state)) return;
      polling = true; const observed = version;
      try {
        const result = await call({ action: 'login_poll' });
        if (observed === version) renderAuth(result);
        await refresh();
      } catch (error) { if (observed === version) show(error.message, true); }
      finally { polling = false; }
    }, 2000);
  }
  function renderAuth(result) {
    if (!result) return;
    if (current.operationId !== result.operationId) qr.replaceChildren();
    current = result;
    authText.textContent = texts[result.state] ?? (result.state === 'idle' ? '' : '正在核对原认证记录');
    operation.textContent = result.operationId ? `本次${result.kind === 'resume' ? '恢复' : '扫码'}记录：${result.operationId}${result.legacy ? '（旧组件记录，当前无法验证）' : ''}` : '';
    uncertainty.hidden = result.authenticationMayHaveOccurred !== true;
    if (result.qr && ['pending', 'scanned'].includes(result.state)) qr.replaceChildren(el('img', { src: result.qr, alt: '本次微信登录二维码' }));
    if (!['pending', 'scanned'].includes(result.state)) qr.replaceChildren();
    if (ended.has(result.state)) { clearInterval(timer); timer = null; }
    schedule(); controls();
  }
  async function authenticate(action, extra = {}) {
    const observed = ++version; starting = action === 'login' || action === 'resume'; controls();
    try {
      const result = await call({ action, ...extra });
      if (observed === version) renderAuth(result);
      await refresh();
    } catch (error) { if (observed === version) show(error.message, true); }
    finally { if (observed === version) { starting = false; controls(); } }
  }
  const login = button('微信扫码登录', () => authenticate('login'), 'primary');
  const resume = button('恢复已保存的微信会话', () => authenticate('resume'), 'primary');
  const cancel = button('取消本次认证', () => { qr.replaceChildren(); return authenticate('login_cancel', { operationId: current.operationId }); });
  const query = button('核对原认证结果', () => authenticate('login_poll'));
  const disconnect = button('断开微信连接', () => perform({ action: 'disconnect' }, '本地代聊已停止；账号断开与原认证结果请分别核对。'));
  function controls() {
    const running = snapshot?.runtime === 'running', account = snapshot?.account, active = !ended.has(current.state);
    setup.hidden = consent.node.hidden = running;
    login.hidden = !running || account?.connected || account?.credentialsAvailable === true;
    resume.hidden = !running || account?.connected || account?.credentialsAvailable !== true;
    login.disabled = resume.disabled = starting || active;
    cancel.hidden = !running || !active; cancel.disabled = current.cancelRequested === true;
    query.hidden = !running || !current.operationId;
    disconnect.hidden = !running;
  }
  const node = el('section', { class: 'stage-card account-section' }, [el('h2', { text: '连接微信账号' }), hint,
    el('p', { class: 'notice', text: '使用 Clowder 重写的本机连接服务，含裁剪的 MIT 协议代码。登录后可能接收其他未选中会话及更广范围消息；逐会话授权前不会交给猫处理。开启代聊后，以你登录的个人微信账号发言。' }),
    el('p', { class: 'muted', text: '凭据与同步数据保存在本机专属加密库，密钥由 macOS 文件钥匙串保护。Host 和模型不会取得原始账号密钥；不会导入桌面微信目录。扫码或恢复连接不会开启代聊。' }),
    el('p', { class: 'muted', text: '当前安全重写仍在验收中，真实账号兼容性、局域网验证及签名升级恢复尚未验收完成。' }),
    consent.node, el('div', { class: 'toolbar' }, [setup, login, resume, cancel, query, disconnect]), authText, operation, uncertainty, qr, sync,
    el('details', { class: 'privacy' }, [el('summary', { text: '数据与授权范围' }),
      el('p', { text: '协议代码来自固定版本的 Agent WeChat 开源代码。微信登录和同步需要连接微信服务器；开启代聊后，所选会话的文字会交给你确认的模型服务。' }), path])]);
  return {
    node,
    render(value) {
      snapshot = value; renderAuth(value.auth);
      const account = value.account;
      hint.textContent = account?.connected ? '账号已连接；请逐会话设置猫的处理与发言范围。' : account?.credentialsAvailable ? '本机保存了账号，当前未在线。请明确恢复；不会自动扫码或重连。' : value.runtime === 'running' ? '连接组件已准备。请用手机微信扫码并核对账号。' : '先确认同步范围并准备连接组件，再选择登录方式。';
      sync.hidden = !account?.connected;
      sync.textContent = value.messageSync?.ready ? '消息同步已完成，可以明确开启所选会话代聊；已有历史不会触发接话。' : '消息历史正在同步；同步完成前不能开启代聊。';
      path.textContent = value.storagePath ? `本机保存位置：${value.storagePath}` : '由宿主的插件专属数据目录管理。';
      controls();
    },
    close() { clearInterval(timer); version++; },
  };
};
