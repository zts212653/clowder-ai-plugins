// Private pipes for an owned child. The supervisor verifies binary identity;
// protocol failure terminates this child and never selects another backend.
const MAX_FRAME = 1024 * 1024;
const METHODS = new Set(['hello', 'status', 'login.start', 'login.poll', 'login.operation', 'login.cancel', 'login.allow_lan', 'account.disconnect',
  'conversation.authorize', 'conversation.pause', 'text.send', 'send.receipt', 'send.cancel', 'sync.pull', 'events.page', 'message.get',
  'directory.start', 'directory.advance', 'directory.operation', 'directory.page', 'session.resume', 'session.operation', 'session.cancel', 'message.by_server']);
const ERRORS = new Set(['invalid_request', 'invalid_params', 'unsupported_method', 'not_ready', 'operation_busy', 'invalid_operation',
  'private_state_unavailable', 'account_service_unavailable', 'observation_unavailable', 'invalid_frame', 'internal_error', 'permission_denied']);
const REFUSED = new Set(['invalid_request', 'invalid_params', 'unsupported_method', 'not_ready', 'operation_busy', 'invalid_operation', 'permission_denied']);
export class NativeRequestError extends Error {
  constructor(code, mayHaveCommitted = false) {
    super('账号连接组件请求未完成'); this.name = 'NativeRequestError'; this.code = code; this.mayHaveCommitted = mayHaveCommitted;
  }
}
export class NativeStdioTransport {
  constructor(child, { timeoutMs = 45000 } = {}) {
    if (!child?.stdin || !child?.stdout || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      throw new NativeRequestError('invalid_request');
    this.child = child; this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map();
    this.frame = Buffer.alloc(MAX_FRAME); this.length = 0; this.closed = false; this.exited = false;
    child.stdout.on('data', bytes => this.receive(bytes));
    child.stdout.once('end', () => this.finish(this.length ? 'protocol_error' : 'connection_closed'));
    child.stdin.on('error', () => { if (!this.exited) this.finish('connection_closed'); });
    child.once('error', () => this.finish('connection_closed'));
    child.once('exit', () => { this.exited = true; });
    child.once('close', () => this.finish('connection_closed'));
    child.stderr?.on('data', () => {}); // Never forward native diagnostics.
  }
  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || this.exited) return Promise.reject(new NativeRequestError('connection_closed'));
    if (!METHODS.has(method)) return Promise.reject(new NativeRequestError('unsupported_method'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      return Promise.reject(new NativeRequestError('invalid_request'));
    if (signal?.aborted) return Promise.reject(new NativeRequestError('request_cancelled'));
    if (this.pending.size >= 16) return Promise.reject(new NativeRequestError('operation_busy'));
    if (!Number.isSafeInteger(this.nextId) || this.nextId < 1) return Promise.reject(new NativeRequestError('request_id_exhausted'));
    const id = this.nextId; let frame;
    try {
      frame = Buffer.from(JSON.stringify({ id, method, params }));
      if (frame.length > MAX_FRAME) return Promise.reject(new NativeRequestError('invalid_request'));
    } catch { return Promise.reject(new NativeRequestError('invalid_request')); }
    this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, written: false, timer: null, abort: null, signal };
      const uncertain = () => {
        this.remove(id);
        reject(new NativeRequestError(entry.written ? 'request_unknown' : 'request_cancelled', entry.written));
      };
      this.pending.set(id, entry);
      entry.abort = uncertain;
      signal?.addEventListener('abort', entry.abort, { once: true });
      entry.timer = setTimeout(uncertain, timeoutMs);
      // No await before write: the caller can order this admission against its
      // durable stop. Local abort/timeout is never a remote cancellation receipt.
      entry.written = true;
      try { this.child.stdin.write(Buffer.concat([frame, Buffer.from('\n')]), error => { if (error) this.finish('connection_closed'); }); }
      catch { this.finish('connection_closed'); }
    });
  }
  remove(id) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id); clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
    return entry;
  }
  receive(bytes) {
    if (this.closed) return;
    if (!Buffer.isBuffer(bytes)) return this.finish('protocol_error');
    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      const newline = bytes.indexOf(10, offset), end = newline === -1 ? bytes.length : newline;
      const count = end - offset;
      if (this.length + count > MAX_FRAME) return this.finish('protocol_error');
      bytes.copy(this.frame, this.length, offset, end); this.length += count;
      if (newline === -1) break;
      let reply;
      try { reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.frame.subarray(0, this.length))); }
      catch { return this.finish('protocol_error'); }
      this.length = 0; offset = newline + 1;
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) || !Number.isSafeInteger(reply.id) || reply.id < 1 || reply.id >= this.nextId)
        return this.finish('protocol_error');
      const keys = Object.keys(reply).sort().join(',');
      if (keys !== 'id,result' && keys !== 'error,id') return this.finish('protocol_error');
      if (keys === 'error,id' && (!reply.error || typeof reply.error !== 'object' || Array.isArray(reply.error) ||
        Object.keys(reply.error).join(',') !== 'code' || !ERRORS.has(reply.error.code))) return this.finish('protocol_error');
      const entry = this.remove(reply.id);
      if (!entry) continue; // Late or duplicate replies never occupy another id.
      if (keys === 'id,result') entry.resolve(reply.result);
      else entry.reject(new NativeRequestError(reply.error.code, entry.written && !REFUSED.has(reply.error.code)));
    }
  }
  finish(code) {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.pending.keys()]) {
      const entry = this.remove(id); entry.reject(new NativeRequestError(code, entry.written));
    }
    this.frame.fill(0); this.length = 0;
    // This is the owned child passed by the supervisor, never a looked-up PID.
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
  close() { this.finish('connection_closed'); }
}
