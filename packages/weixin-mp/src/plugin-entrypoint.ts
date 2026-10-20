import {
  definePlugin,
  definePluginModule,
  type FeatureContext,
  type PluginModuleEntrypoint,
  type PluginModuleDefinition,
  type ModulePluginHostShape,
} from '@clowder-ai/plugin-sdk';

import { WeixinAccessTokenManager } from './access-token-manager.js';
import {
  createWeixinMpHandlers,
  type InvokeContext,
  type InvokeHandler,
  type TokenManager,
} from './handlers.js';

const LIMB_METHODS = [
  'weixin-mp:check_status',
  'weixin-mp:convert_markdown',
  'weixin-mp:create_draft',
  'weixin-mp:update_draft',
  'weixin-mp:upload_image',
  'weixin-mp:upload_material',
] as const;

const TEST_METHOD = 'weixin-mp:test_connection';

export interface WeixinMpPluginModuleOptions {
  readonly createHandlers?: typeof createWeixinMpHandlers;
  readonly createTokenManager?: (input: { readonly appId: string; readonly appSecret: string }) => TokenManager;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a declared ${name === 'appSecret' ? 'secret' : 'string'}`);
  }
  return value;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function limbParams(value: unknown, method: string): Readonly<Record<string, unknown>> {
  const input = record(value, `${method} input`);
  if (!Object.hasOwn(input, 'params')) throw new TypeError(`${method} input must contain params`);
  if (Object.keys(input).some((key) => key !== 'params' && key !== 'invocation')) {
    throw new TypeError(`${method} input contains an unsupported field`);
  }
  return record(input.params, `${method} params`);
}

async function activationContext(
  context: Pick<FeatureContext, 'config' | 'secrets'>,
  createTokenManager: NonNullable<WeixinMpPluginModuleOptions['createTokenManager']>,
): Promise<InvokeContext> {
  const [appIdValue, appSecretValue] = await Promise.all([
    context.config.get('appId'),
    context.secrets.get('appSecret'),
  ]);
  const appId = requiredString(appIdValue, 'appId');
  const appSecret = requiredString(appSecretValue, 'appSecret');
  return {
    pluginConfig: {
      WEIXIN_MP_APP_ID: appId,
      WEIXIN_MP_APP_SECRET: appSecret,
    },
    tokenManager: createTokenManager({ appId, appSecret }),
  };
}

function requireHandler(handlers: Readonly<Record<string, InvokeHandler>>, method: string): InvokeHandler {
  const handler = handlers[method];
  if (handler === undefined) throw new TypeError(`weixin-mp handler ${method} is unavailable`);
  return handler;
}

type SettingsHost = Pick<ModulePluginHostShape, 'config' | 'secrets'>;
export interface SettingsEntrypoint extends PluginModuleEntrypoint {
  create(manifest: unknown): PluginModuleDefinition & {
    settings(host: SettingsHost): Promise<{
      actions: Readonly<Record<string, () => Promise<unknown>>>;
      dispose(): void | Promise<void>;
    }>;
  };
}

function connectionTest(handlers: Readonly<Record<string, InvokeHandler>>, invokeContext: InvokeContext) {
  return async () => {
    const result = await requireHandler(handlers, 'weixin-mp:check_status')({}, invokeContext);
    const data = result.success
      ? result.data as { readonly status?: unknown; readonly message?: unknown } | undefined
      : undefined;
    const status = data?.status;
    const connected = result.success && status === 'connected';
    return {
      ok: connected,
      message: connected
        ? 'WeChat Official Account is connected'
        : typeof data?.message === 'string'
          ? data.message
          : 'WeChat Official Account connection failed',
      details: { status: typeof status === 'string' ? status : 'error' },
    };
  };
}

export function createWeixinMpPluginModule(
  options: WeixinMpPluginModuleOptions = {},
): SettingsEntrypoint {
  const createHandlers = options.createHandlers ?? createWeixinMpHandlers;
  const createTokenManager = options.createTokenManager
    ?? ((input) => new WeixinAccessTokenManager(input));
  const runtimeModule = definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'publish-official-account-content': async (context) => {
        const invokeContext = await activationContext(context, createTokenManager);
        const handlers = createHandlers();
        const actions = Object.fromEntries(LIMB_METHODS.map((method) => [
          method,
          (input: unknown) => requireHandler(handlers, method)(limbParams(input, method), invokeContext),
        ]));
        return {
          actions: {
            ...actions,
            [TEST_METHOD]: connectionTest(handlers, invokeContext),
          },
          dispose: () => invokeContext.tokenManager.invalidateAccessToken(),
        };
      },
    },
  }));
  return {
    create(manifest) {
      return {
        ...runtimeModule.create(manifest),
        settings: async host => {
          const [appIdValue, appSecretValue] = await Promise.all([host.config.get('appId'), host.secrets.get('appSecret')]);
          const appId = typeof appIdValue === 'string' ? appIdValue : '';
          const appSecret = typeof appSecretValue === 'string' ? appSecretValue : '';
          // The original check_status reports not_configured before requesting a token.
          const invokeContext: InvokeContext = {
            pluginConfig: { WEIXIN_MP_APP_ID: appId, WEIXIN_MP_APP_SECRET: appSecret },
            tokenManager: createTokenManager({ appId, appSecret }),
          };
          return {
            actions: { [TEST_METHOD]: connectionTest(createHandlers(), invokeContext) },
            dispose: () => invokeContext.tokenManager.invalidateAccessToken(),
          };
        },
      };
    },
  };
}

export default createWeixinMpPluginModule();
