import { createChildRpc } from './child-rpc.mjs';
import { createGameRuntime } from './game-runtime.mjs';

let runtime;
const rpc = createChildRpc(process, async (method, input) => {
  if (method === 'initialize') {
    if (runtime) throw new Error('棋桌已经启动');
    runtime = createGameRuntime(input.dataRoot, (name, value) => rpc.call(name, value));
    await runtime.recover();
    return { ready: true };
  }
  if (!runtime || !['binding', 'open', 'candidates', 'play', 'stop'].includes(method)) throw new Error('棋桌操作不可用');
  return runtime[method](input);
});
process.once('disconnect', () => { void runtime?.stop({ revoke: false }).finally(() => process.exit(0)); });
