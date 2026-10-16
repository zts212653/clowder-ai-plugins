export class CdpConnection {
  #next = 0;
  #pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const item = this.#pending.get(message.id);
      if (!item) return;
      this.#pending.delete(message.id);
      clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  static async open(url, { signal } = {}) {
    signal?.throwIfAborted();
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('INVALID_LOCAL_BROWSER_ENDPOINT');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const abort = () => {
        socket.close();
        finish(signal.reason);
      };
      const timer = setTimeout(() => {
        socket.close();
        finish(new Error('BROWSER_CONNECTION_TIMEOUT'));
      }, 10000);
      const finish = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      socket.addEventListener('open', () => finish(), { once: true });
      socket.addEventListener('error', () => finish(new Error('BROWSER_CONNECTION_FAILED')), { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    return new CdpConnection(socket);
  }
  call(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('BROWSER_CLOSED'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('BROWSER_COMMAND_TIMEOUT'));
      }, 10000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
  async evaluate(expression, sessionId) {
    const response = await this.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (response.exceptionDetails) throw new Error('TRIPO_PAGE_ADAPTER_FAILED');
    return response.result.value;
  }
  rejectPending() {
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('BROWSER_CLOSED'));
    }
    this.#pending.clear();
  }
  close() {
    this.rejectPending();
    this.socket.close();
  }
}
