import { randomUUID } from 'node:crypto';

/** Bounded, credential-free IPC between this plugin and its own game process. */
export function createChildRpc(channel, handle) {
  const pending = new Map();
  let closed = false;
  const send = (frame) => {
    if (closed || !channel.connected) throw new Error('棋桌进程已停止');
    if (Buffer.byteLength(JSON.stringify(frame)) > 256_000) throw new Error('棋桌消息过大');
    channel.send(frame);
  };
  const receive = async (frame) => {
    if (!frame || typeof frame.id !== 'string' || frame.id.length > 100) return;
    if (frame.kind === 'result') {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error(frame.error));
      else waiter.resolve(frame.result);
      return;
    }
    if (frame.kind !== 'request' || typeof frame.method !== 'string' || frame.method.length > 80) return;
    try {
      const result = await handle(frame.method, frame.input);
      send({ kind: 'result', id: frame.id, result });
    } catch (error) {
      if (!closed) send({ kind: 'result', id: frame.id, error: String(error.message ?? error).slice(0, 500) });
    }
  };
  channel.on('message', receive);
  const close = () => {
    if (closed) return;
    closed = true;
    channel.off('message', receive);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('棋桌进程已停止，棋谱仍保留'));
    }
    pending.clear();
  };
  channel.once('disconnect', close);
  return {
    close,
    call(method, input) {
      if (closed || pending.size >= 32) return Promise.reject(new Error('棋桌暂不可用'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('棋桌请求超时；请先读取当前棋局再重试'));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        try { send({ kind: 'request', id, method, input }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
  };
}
