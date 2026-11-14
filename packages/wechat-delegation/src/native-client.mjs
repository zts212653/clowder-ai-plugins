// Protocol provenance: thisnick/agent-wechat @
// 1e7dec817ca2ff893b8365b768058b6c0274563d, shared/src/native-client.ts
// and native.generated.ts. This independent adapter has no OpenClaw dependency.
const segment = value => {
  if (typeof value !== 'string' || !value || value.length > 256 || value === '.' || value === '..' || /[\u0000-\u001f]/.test(value)) throw Error('invalid platform coordinate');
  return encodeURIComponent(value);
};
export class NativeClient {
  constructor({ baseUrl, token, fetch: transport = globalThis.fetch, timeoutMs = 15000 }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
      throw Error('native channel requires a private loopback origin');
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{24,512}$/.test(token)) throw Error('invalid native credential');
    this.base = url; this.token = token; this.fetch = transport; this.timeoutMs = timeoutMs;
  }
  async bytes(path, { method = 'GET', body, key, signal, image = false } = {}) {
    if (!path.startsWith('v1/')) throw Error('undeclared native route');
    const response = await this.fetch(new URL(path, this.base), { method, redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`native request failed (${response.status})`); }
    if (image && !response.headers.get('content-type')?.startsWith('image/png')) { await response.body?.cancel(); throw Error('QR is not PNG'); }
    const max = 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw Error('native response exceeds bound'); }
    if (!response.body) throw Error('empty native response');
    const reader = response.body.getReader(); let length = 0; const chunks = [];
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > max) throw Error('native response exceeds bound'); chunks.push(chunk.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async json(path, options) { return JSON.parse((await this.bytes(path, options)).toString('utf8')); }
  status() { return this.json('v1/status'); }
  account(accountId) { return this.json(`v1/accounts/${segment(accountId)}`); }
  async identity(accountId) {
    const [status, account] = await Promise.all([this.status(), this.account(accountId)]);
    if (status.version?.product !== 'agent-wechat' || status.version?.backend !== 'native' || status.version?.apiVersion !== 1 ||
        typeof status.serverId !== 'string' || account.id !== accountId) throw Error('native identity mismatch');
    return { serverId: status.serverId, accountId, accountIdentity: account.ownUsername,
      connected: account.authenticated === true && account.connection === 'online' };
  }
  async prepare(run) {
    const current = await this.identity(run.accountId);
    if (!current.connected || !current.accountIdentity || current.accountIdentity !== run.accountIdentity || current.serverId !== run.serverId)
      throw Error('account identity changed or connection lost');
  }
  createAccount(accountId) { return this.json('v1/accounts', { method: 'POST', body: { id: accountId } }); }
  threads(accountId, cursor = '') { return this.json(`v1/accounts/${segment(accountId)}/threads?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); }
  message(accountId, messageId) { return this.json(`v1/accounts/${segment(accountId)}/messages/${segment(messageId)}`); }
  events(accountId, cursor = '0') {
    if (!/^\d+$/.test(cursor)) throw Error('invalid event cursor');
    return this.json(`v1/accounts/${segment(accountId)}/events?after=${cursor}&limit=100`);
  }
  login(accountId, key) { return this.json(`v1/accounts/${segment(accountId)}/auth/login`, { method: 'POST', key,
    body: { allowQr: true, forceQr: true, timeoutSeconds: 300, computerName: 'Clowder AI' } }); }
  operation(accountId, operationId) { return this.json(`v1/accounts/${segment(accountId)}/operations/${segment(operationId)}`); }
  async qr(accountId, operationId) { return `data:image/png;base64,${(await this.bytes(`v1/accounts/${segment(accountId)}/operations/${segment(operationId)}/qr`, { image: true })).toString('base64')}`; }
  disconnect(accountId) { return this.json(`v1/accounts/${segment(accountId)}/auth/disconnect`, { method: 'POST', body: {} }); }
  normalize(run, value) {
    if (!value || typeof value.id !== 'string' || !value.id || value.accountId !== run.accountId || value.destination !== run.conversationId ||
        run.sendId && value.id !== run.sendId || !['queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled'].includes(value.state)) throw Error('native receipt identity mismatch');
    return { sendId: value.id, state: value.state, ...(typeof value.localMessageId === 'string' ? { messageId: value.localMessageId } : {}) };
  }
  // No awaits before bytes() starts fetch: the service orders this exact call
  // against its durable takeover. Identity preflight happens before that gate.
  async submit(run) {
    return this.normalize(run, await this.json(`v1/accounts/${segment(run.accountId)}/sends`, {
      method: 'POST', key: run.id, body: { threadId: run.conversationId, text: run.text } }));
  }
  async inspect(run) {
    const path = run.sendId ? `sends/${segment(run.sendId)}` : `sends/by-idempotency-key?key=${encodeURIComponent(run.id)}`;
    const value = await this.json(`v1/accounts/${segment(run.accountId)}/${path}`);
    const receipt = this.normalize(run, value);
    if (receipt.state === 'accepted' && value.localMessageId && typeof value.serverId === 'string' && /^[1-9]\d*$/.test(value.serverId)) {
      const message = await this.message(run.accountId, value.localMessageId);
      if (message.id !== value.localMessageId || message.accountId !== run.accountId || message.threadId !== run.conversationId ||
          message.direction !== 'outgoing' || message.serverId !== value.serverId || message.body !== run.text) throw Error('canonical message identity mismatch');
      return { ...receipt, verified: true, messageId: message.id };
    }
    return receipt;
  }
  async cancel(run) { return this.normalize(run, await this.json(`v1/accounts/${segment(run.accountId)}/sends/${segment(run.sendId)}/cancel`, { method: 'POST', body: {} })); }
}
