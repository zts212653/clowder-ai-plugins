import { VERSION } from './contract.mjs';
import { readStatus } from './status.mjs';
import { TOOL_BUDGET_MS } from './tool-request.mjs';

// Public structural module contract; no Host internals or SDK source copy.
export function createTripoPluginModule({ probe = readStatus } = {}) {
  function session() {
    const lifetime = new AbortController();
    return {
      actions: {
        'tripo.status': async (_input, _context, hostContext) => {
          const signal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(TOOL_BUDGET_MS),
            ...(hostContext?.signal ? [hostContext.signal] : []),
          ]);
          signal.throwIfAborted();
          const data = await probe({ signal });
          signal.throwIfAborted();
          const connected = data.live.status === 'connected';
          return {
            render: 'status',
            data,
            label: `插件 v${VERSION} · 本机组件 · ${connected ? '已连接' : '未连接'}${data.live.observedVersion ? ` · v${data.live.observedVersion}` : ''}${data.nextAction ? ` · ${data.nextAction}` : ''}`,
          };
        },
      },
      dispose: () => lifetime.abort(new Error('TRIPO_MODULE_STOPPED')),
    };
  }
  return {
    create(manifest) {
      if (manifest?.pluginId !== 'official.tripo-studio' || manifest.version !== VERSION) {
        throw new TypeError('TRIPO_MANIFEST_MISMATCH');
      }
      return {
        settings: async () => session(),
        start: async () => {
          const active = session();
          return { actions: active.actions, stop: active.dispose };
        },
      };
    },
  };
}

export default createTripoPluginModule();
