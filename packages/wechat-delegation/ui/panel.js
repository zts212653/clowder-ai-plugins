(() => {
  const channel = 'clowder-plugin-ui/v1', nonce = window.name, pending = new Map(); let sequence = 0;
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || data?.channel !== channel || data.nonce !== nonce) return;
    const item = pending.get(data.requestId); if (!item) return;
    pending.delete(data.requestId); clearTimeout(item.timer);
    if (data.error) item.reject(Error(data.error)); else item.resolve(data.result);
  });
  const call = body => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error('操作回执待核对，请刷新状态；不会自动重复发送。')); }, 180000);
    pending.set(requestId, { timer, reject, resolve: response => response.status >= 200 && response.status < 300 ? resolve(response.body) : reject(Error(response.body?.error ?? '操作未完成')) });
    parent.postMessage({ channel, nonce, requestId, type: 'http', request: { method: 'POST', path: 'control', body } }, '*');
  });
  const el = (tag, attributes = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children); return node;
  };
  const button = (text, action, className = '') => el('button', { text, type: 'button', class: className, onclick: action });
  let fieldSequence = 0;
  const label = (text, field) => {
    const fieldId = `wechat-field-${++fieldSequence}`; field.id = fieldId;
    return el('div', { class: 'field' }, [el('label', { htmlFor: fieldId, text }), field]);
  };
  const check = (text, checked = false) => {
    const input = el('input', { type: 'checkbox', checked });
    return { input, node: el('label', { class: 'check' }, [input, el('span', { text })]) };
  };
  let state, choicesLoaded = false, choices = [], selectedPreview, previewCat, showEditor = false, wasConnected = false;
  const app = document.querySelector('#app');
  const message = el('div', { id: 'message', role: 'status', 'aria-live': 'polite' });
  const show = (text, error = false) => { message.textContent = text; message.className = error ? 'error' : ''; };
  const perform = async (body, success) => {
    try { const value = await call(body); if (value?.policies) render(value); if (success) show(success); await refresh(); return value; }
    catch (error) { show(error.message, true); return null; }
  };
  const globalStop = button('暂停全部代聊', () => perform({ action: 'pause_all' }, '本地代聊已停止；在途消息请继续核对。'), 'stop');
  app.append(el('header', {}, [el('div', {}, [el('h1', { text: '微信代聊' }), el('p', { class: 'muted', text: '指定好友或群，让猫主动聊。你随时接手。' })]), globalStop]), message);
  const summary = el('div', { class: 'statusline' }); app.append(summary);
  const consent = check('我了解将准备第三方 Agent WeChat 2.4.1；登录可能同步更广范围消息到本机。猫只处理我另行授权的会话。');
  const setup = button('准备账号连接组件', async () => {
    if (!consent.input.checked) return show('请先阅读并确认客户端同步范围。', true);
    setup.disabled = true; show('正在校验并准备连接组件…');
    await perform({ action: 'prepare', acceptThirdParty: true }, '连接组件已准备，可以扫码。'); setup.disabled = false;
  }, 'primary');
  let pollTimer, pollingLogin = false;
  const qr = el('div', { id: 'qr' }), loginState = el('p', { class: 'muted' });
  const renderLogin = result => {
    if (!result) return;
    const texts = { requesting: '正在建立同一次扫码操作', awaiting_scan: '请用手机微信扫码', awaiting_approval: '请在手机微信确认', succeeded: '账号身份已核验；猫的处理权限仍需单独开启', failed: '登录未完成，请检查后重试', expired: '二维码已过期，可在原记录重新扫码' };
    loginState.textContent = texts[result.state] ?? `登录状态：${result.state}`;
    if (result.qr) qr.replaceChildren(el('img', { src: result.qr, alt: '本次微信登录二维码' }));
    if (['succeeded', 'failed', 'expired', 'cancelled', 'rejected', 'needs_login'].includes(result.state)) { clearInterval(pollTimer); if (result.state === 'succeeded') qr.replaceChildren(); }
  };
  const login = button('微信扫码登录', async () => {
    const result = await perform({ action: 'login' }); renderLogin(result); clearInterval(pollTimer);
    if (!result || ['succeeded', 'failed', 'expired', 'cancelled'].includes(result.state)) return;
    pollTimer = setInterval(async () => {
      if (pollingLogin) return; pollingLogin = true;
      try { renderLogin(await call({ action: 'login_poll' })); await refresh(); } catch (error) { show(error.message, true); clearInterval(pollTimer); }
      finally { pollingLogin = false; }
    }, 2000);
  });
  const storePath = el('small');
  const connectionDetails = el('details', { open: true }, [el('summary', { text: '账号连接与数据范围' }),
    el('p', { text: '连接组件会在宿主专属目录保存微信登录凭据、客户端同步数据和代聊记录；不会导入桌面微信的本地数据目录。' }),
    el('p', { text: '底层客户端可能收到其他会话；选择前不会把正文交给猫或模型。扫码完成不会自动开启任何代聊。此第三方通道的账号兼容性和真实收发仍须验证。' }),
    consent.node, el('div', { class: 'toolbar' }, [setup, login, button('核对当前状态', () => perform({ action: 'status' })),
      button('断开账号并停止代聊', () => perform({ action: 'disconnect' }, '本地代聊已停止，账号断开结果请核对。'))]), loginState, qr, storePath]);
  app.append(el('section', {}, [el('h2', { text: '微信账号' }), connectionDetails]));

  const target = el('select', { required: true }), cat = el('select', { required: true });
  const persona = el('textarea', { placeholder: '例如：以我的助理口吻，礼貌简短，不谈工作机密', required: true });
  const goal = el('textarea', { placeholder: '例如：在周末球局群问问今晚八点谁来，并跟进人数', required: true });
  const proactive = check('允许猫主动发起聊天', true), replies = check('允许猫自动接话', true), scheduled = check('允许按时段持续主动发起（对方未回时停止追问）');
  const windowStart = el('input', { type: 'time', value: '09:00', required: true }), windowEnd = el('input', { type: 'time', value: '21:00', required: true });
  const timeZone = el('input', { value: Intl.DateTimeFormat().resolvedOptions().timeZone, required: true });
  const interval = el('input', { type: 'number', min: 1, max: 1440, value: 180, required: true }), daily = el('input', { type: 'number', min: 1, max: 20, value: 2, required: true });
  const turns = el('input', { type: 'number', min: 1, max: 1000, value: 20, required: true });
  const notification = el('select'), expires = el('input', { type: 'datetime-local' });
  const modelInfo = el('div', { class: 'notice', text: '选择猫后，先核对实际模型服务。' });
  const confirm = check('我允许所选会话的文字交给上述模型服务，并允许猫在约定范围内直接发送。家庭记忆、文件、命令、支付、外链和附件访问均不开放。');
  const loadPreview = async () => {
    selectedPreview = null; confirm.input.checked = false;
    if (!cat.value || !state?.memberRuntimeAvailable) return;
    const selected = cat.value; modelInfo.textContent = '正在核对模型服务…';
    try {
      const result = await call({ action: 'cat_details', catId: selected });
      if (cat.value !== selected) return;
      selectedPreview = result; previewCat = selected;
      modelInfo.textContent = result.available ? `实际模型：${result.runtime?.model ?? '未知'}；客户端：${result.runtime?.clientId ?? '未知'}。所选会话文字会通过此服务处理并保存在宿主，不读取家庭记忆。` : '这只猫的受限模型服务当前不可用。';
    } catch (error) { modelInfo.textContent = error.message; }
  };
  cat.addEventListener('change', loadPreview);
  const fillPolicy = async policy => {
    showEditor = true; formSection.hidden = false;
    const value = JSON.stringify({ id: policy.conversationId, kind: policy.kind });
    if (![...target.options].some(option => option.value === value)) target.add(el('option', { value, text: policy.displayName }));
    target.value = value; cat.value = policy.catId; persona.value = policy.persona; goal.value = policy.goal;
    proactive.input.checked = policy.proactive; replies.input.checked = policy.replies; scheduled.input.checked = policy.scheduleEnabled === true;
    interval.value = policy.intervalMinutes; turns.value = policy.maxTurns; daily.value = policy.maxProactivePerDay;
    const time = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    windowStart.value = time(policy.windowStart); windowEnd.value = time(policy.windowEnd);
    timeZone.value = policy.timeZone;
    if (policy.notificationThreadId && ![...notification.options].some(option => option.value === policy.notificationThreadId))
      notification.add(el('option', { value: policy.notificationThreadId, text: policy.notificationThreadTitle ?? '原提醒对话' }));
    notification.value = policy.notificationThreadId ?? ''; confirm.input.checked = false;
    expires.value = policy.expiresAt ? new Date(policy.expiresAt - new Date(policy.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    await loadPreview(); form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const minute = value => { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; };
  const form = el('form', { onsubmit: async event => {
    event.preventDefault();
    if (!confirm.input.checked || !selectedPreview?.available || previewCat !== cat.value) return show('请先核对模型服务并确认数据范围。', true);
    if (!target.value) return show('请选择真实好友或群。', true);
    const chosen = JSON.parse(target.value), previous = state.policies.find(item => item.conversationId === chosen.id && item.accountIdentity === state.account?.accountIdentity);
    const result = await perform({ action: 'activate', target: chosen, catId: cat.value, persona: persona.value, goal: goal.value,
      proactive: proactive.input.checked, replies: replies.input.checked, scheduleEnabled: scheduled.input.checked,
      intervalMinutes: Number(interval.value), maxTurns: Number(turns.value), maxProactivePerDay: Number(daily.value),
      timeZone: timeZone.value, windowStart: minute(windowStart.value), windowEnd: minute(windowEnd.value),
      expiresAt: expires.value ? new Date(expires.value).getTime() : null, notificationThreadId: notification.value || null,
      confirm: true, expectedEpoch: previous?.epoch ?? 0, modelFingerprint: selectedPreview.fingerprint }, '代聊已开启。可在下方立即主动开口，或随时由你接管。');
    if (result) { confirm.input.checked = false; showEditor = false; formSection.hidden = true; policies.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } }, [
    el('div', { class: 'grid' }, [label('指定好友或群', target), label('值班猫', cat), label('人设与交流边界', persona), label('这次要聊什么', goal)]),
    el('p', { class: 'muted', text: '群授权仅限本群，不扩展到群成员私聊或其他群。涉及资金、验证码、账号安全或对方找本人时暂停并交还你。' }),
    el('div', { class: 'toolbar' }, [proactive.node, replies.node]), scheduled.node,
    el('fieldset', {}, [el('legend', { text: '持续主动聊天的范围' }), el('div', { class: 'grid' }, [label('开始时间', windowStart), label('结束时间', windowEnd), label('时区', timeZone),
      label('主动间隔（分钟）', interval), label('每天最多主动次数', daily), label('本次最多聊天轮数', turns)])]),
    el('div', { class: 'grid' }, [label('需要本人时提醒到', notification), label('可选：代聊执行到期时间（留空长期保留配置）', expires)]),
    el('p', { class: 'muted', text: '选定提醒对话后，本人在那个 Clowder 对话中单独说“我来聊”，会停止绑定在那里的代聊；说“暂停全部代聊”则全局停止。微信群友无法通过聊天文字改变控制权。' }),
    modelInfo, confirm.node, el('button', { type: 'submit', text: '开启 / 明确交回值班猫', class: 'primary' })]);
  let nextCursor = null;
  const more = button('加载更多好友与群', async () => { try { await loadChats(nextCursor); } catch (error) { show(error.message, true); } }); more.hidden = true;
  const loadChats = async (cursor = '') => {
    const result = await call({ action: 'chats', cursor });
    for (const item of result.items) if (!choices.some(old => old.id === item.id)) {
      choices.push(item); target.add(el('option', { value: JSON.stringify({ id: item.id, kind: item.kind }), text: `${item.displayName} · ${item.kind === 'group' ? '群' : '好友'} · ${item.id.slice(-12)}` }));
    }
    nextCursor = result.nextCursor; more.hidden = !nextCursor;
  };
  const formSection = el('section', {}, [el('div', { class: 'row' }, [el('h2', { text: '指定会话与值班猫' }), button('返回会话列表', () => { showEditor = false; formSection.hidden = true; policies.scrollIntoView({ behavior: 'smooth' }); })]), form, more]); app.append(formSection);
  formSection.hidden = true;
  const policies = el('div', { class: 'cards' }), attempts = el('div', { class: 'cards' });
  const history = el('div'); let historyCursor;
  const historyMore = button('查询持久历史记录', async () => {
    try {
      const page = await call({ action: 'history', ...(historyCursor === undefined ? {} : { cursor: historyCursor }) });
      for (const run of page.items) history.append(el('details', {}, [el('summary', { text: `${new Date(run.createdAt).toLocaleString()} · ${run.conversationId} · ${run.phase}（查询时状态）` }), el('pre', { text: run.text ?? run.incomingText ?? '尚无正文' })]));
      historyCursor = page.nextCursor; historyMore.disabled = historyCursor === null;
      historyMore.textContent = historyCursor === null ? `已查询全部 ${page.total} 条持久记录` : '继续查询较早记录';
    } catch (error) { show(error.message, true); }
  });
  app.append(el('section', {}, [el('div', { class: 'row' }, [el('h2', { text: '当前会话 · 你随时接手' }), button('授权新的好友或群', () => {
    if (!state?.account?.connected) return show('请先连接并核验微信账号。', true);
    showEditor = true; formSection.hidden = false; target.value = ''; confirm.input.checked = false; form.scrollIntoView({ behavior: 'smooth' });
  })]), policies]),
    el('section', {}, [el('div', { class: 'row' }, [el('h2', { text: '在途消息与发送记录' }), button('只查询原记录', () => perform({ action: 'inspect' }))]),
      el('p', { class: 'muted', text: '本地接管先停止后续代聊。已经移交组件、取消结果尚未确认的消息仍可能发出；“暂未看到”不能证明未发送，系统不会自动重发。' }), attempts,
      el('details', {}, [el('summary', { text: '全部持久历史（分页只读）' }), el('p', { class: 'muted', text: '记录不会因停用、过期或超出近期列表而删除。这里显示查询时的历史状态；未决发送始终保留在上方实时列表。' }), history, historyMore])]));
  const render = snapshot => {
    state = snapshot;
    summary.replaceChildren(...[snapshot.account?.connected ? `${snapshot.accountIsLive ? '微信账号' : '上次核验的微信账号'}：${snapshot.account.accountIdentity}` : '微信账号：尚未连接或待核验',
      snapshot.memberRuntimeAvailable ? '受限猫会话：可用' : '受限猫会话：宿主暂不支持', snapshot.globalPause ? '全部代聊已暂停' : `正在代聊：${snapshot.policies.filter(p => p.mode === 'active').length} 个会话`].map(text => el('span', { class: 'badge', text })));
    login.disabled = snapshot.runtime !== 'running';
    formSection.hidden = !snapshot.account?.connected || snapshot.policies.length > 0 && !showEditor;
    if (snapshot.account?.connected && !wasConnected) connectionDetails.open = false;
    if (!snapshot.account?.connected) connectionDetails.open = true;
    wasConnected = Boolean(snapshot.account?.connected);
    storePath.textContent = snapshot.storagePath ? `本机保存位置：${snapshot.storagePath}` : '保存位置由宿主的插件专属数据目录管理。';
    policies.replaceChildren();
    if (!snapshot.policies.length) policies.append(el('p', { class: 'empty', text: '尚未授权任何好友或群。登录后选择具体会话，再开启代聊。' }));
    for (const policy of snapshot.policies) {
      const unresolved = snapshot.runs.filter(run => run.policyId === policy.id && run.submitted && ['submitting', 'queued', 'needs_review'].includes(run.phase)).length;
      const status = policy.mode === 'active' ? '猫代聊中 · 可随时接管' : policy.mode === 'owner' ? policy.ownerReason === 'boundary' ? '需要本人处理 · 猫已停止代聊' : '本人接管中 · 后续代聊已停止' : policy.mode === 'revoked' ? '会话授权已撤销' : policy.mode === 'expired' ? '代聊许可已到期 · 后续执行停止' : '代聊已暂停 · 需本人明确恢复';
      const start = button('立即主动开口', () => perform({ action: 'initiate', policyId: policy.id, operationId: crypto.randomUUID() }, '请求已接收；实际发送结果见下方记录。'));
      start.disabled = policy.mode !== 'active' || !policy.proactive || unresolved > 0 || policy.unanswered >= 1;
      policies.append(el('article', { class: 'card' }, [el('div', { class: 'row' }, [el('h3', { text: `${policy.displayName} · ${policy.kind === 'group' ? '群' : '好友'}` }), el('span', { class: 'badge', text: status })]),
        el('p', { text: `值班：${policy.catDisplayName ?? '所选猫'} · 主动发起${policy.proactive ? '开启' : '关闭'} · 自动接话${policy.replies ? '开启' : '关闭'}` }),
        el('p', { class: 'muted', text: policy.goal }),
        ...(unresolved ? [el('p', { class: 'error', text: `${unresolved} 笔在途或未知结果待核对，仍可能发出。` })] : []),
        el('div', { class: 'toolbar' }, [button('我来聊', () => perform({ action: 'takeover', policyId: policy.id }, '本地后续代聊已停止；在途结果单独核对。'), 'stop'), start,
          button('交回 / 换猫 / 修改范围', () => fillPolicy(policy)), button('撤销会话授权', () => perform({ action: 'revoke', policyId: policy.id }, '已撤销此会话的后续处理。'))])]));
    }
    const phases = { generating: '猫正在起草', prepared: '已生成 · 尚未移交', submitting: '已移交组件 · 结果待核对', queued: '组件内待发送', accepted: '平台已受理 · 对端实收未验证',
      sent: '平台记录已核验 · 不代表已读', needs_review: '发送结果未知 · 不会自动重发', cancelled: '本轮已取消', failed: '本轮未完成 · 已暂停', needs_owner: '需要本人处理 · 已暂停', silent: '无需继续发言 · 已暂停', owner_confirmed_sent: '本人已确认在微信发出' };
    attempts.replaceChildren();
    if (!snapshot.runs.length) attempts.append(el('p', { class: 'empty', text: '还没有发送记录。这里会保留每一轮实际处理状态。' }));
    for (const run of snapshot.runs) {
      const policy = snapshot.policies.find(item => item.id === run.policyId), detail = el('details', {}, [el('summary', { text: '查看本轮正文与状态' }), el('pre', { text: run.text ?? run.incomingText ?? '尚未生成正文' })]);
      const card = el('article', { class: 'card' }, [el('h3', { text: `${policy?.displayName ?? run.conversationId} · ${phases[run.phase] ?? run.phase}` }),
        el('small', { text: `${new Date(run.createdAt).toLocaleString()} · ${run.trigger === 'reply' ? '自动接话' : '主动开口'}` }),
        ...(run.cancelRequested && ['queued', 'submitting', 'needs_review'].includes(run.phase) ? [el('p', { class: 'error', text: '本地已停止后续代聊；组件取消尚未确认，这条仍可能发出。' })] : []), detail]);
      if (run.submitted && ['queued', 'submitting', 'needs_review', 'accepted'].includes(run.phase)) {
        const verified = check('我已在微信核对这条消息的实际会话与全文，确认已经发出');
        const seen = button('记录本人已看到发出', () => perform({ action: 'confirm_seen', runId: run.id }, '已记录本人核对结果，原消息不会自动重发。')); seen.disabled = true;
        verified.input.addEventListener('change', () => { seen.disabled = !verified.input.checked; });
        detail.append(verified.node, seen);
      }
      attempts.append(card);
    }
    if (snapshot.lastError) show(snapshot.lastError, true);
  };
  let refreshing = false;
  async function refresh() {
    if (refreshing) return; refreshing = true;
    try {
      render(await call({ action: 'status' }));
      if (state.account?.connected && !choicesLoaded) {
        choices = []; target.replaceChildren(el('option', { value: '', text: '选择真实好友或群' })); await loadChats();
        const roster = await call({ action: 'cats' }); cat.replaceChildren(el('option', { value: '', text: '选择值班猫' }), ...roster.items.map(item => el('option', { value: item.id, text: item.label })));
        notification.replaceChildren(el('option', { value: '', text: '仅在此控制台提醒' }), ...roster.threads.map(item => el('option', { value: item.id, text: item.title })));
        choicesLoaded = true;
      }
    } catch (error) { show(error.message, true); } finally { refreshing = false; }
  }
  refresh(); const timer = setInterval(refresh, 3000);
  window.addEventListener('pagehide', () => { clearInterval(timer); clearInterval(pollTimer); for (const item of pending.values()) clearTimeout(item.timer); });
})();
