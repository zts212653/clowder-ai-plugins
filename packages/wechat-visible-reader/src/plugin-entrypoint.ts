import {
  definePlugin,
  definePluginModule,
  type FeatureContext,
  type PluginModuleEntrypoint,
} from '@clowder-ai/plugin-sdk';

import { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderMetrics } from './WeChatVisibleReaderMetrics.js';
import { createWeChatVisibleReaderHandlers, type InvokeContext } from './handlers.js';
import {
  createWeChatVisibleReaderNativeRunner,
  type WeChatVisibleReaderNativeRunner,
} from './native-runner.js';

const VISIBLE_METHOD = 'wechat-visible-reader:read_visible_conversation';
const RECENT_METHOD = 'wechat-visible-reader:read_conversation_recent';
const ARM_METHOD = 'wechat-visible-reader:arm';
const DISARM_METHOD = 'wechat-visible-reader:disarm';
const STATUS_METHOD = 'wechat-visible-reader:status';
const INVOCATION_KEYS = new Set(['catId', 'invocationId', 'userId', 'threadId', 'userMessageId']);

export interface WeChatVisibleReaderPluginModuleOptions {
  readonly createRunner?: () => WeChatVisibleReaderNativeRunner;
  readonly now?: () => number;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function limbInput(value: unknown, method: string): {
  readonly params: Readonly<Record<string, unknown>>;
  readonly context: InvokeContext;
} {
  const input = record(value, `${method} input`);
  if (!Object.hasOwn(input, 'params')) throw new TypeError(`${method} input must contain params`);
  if (Object.keys(input).some((key) => key !== 'params' && key !== 'invocation')) {
    throw new TypeError(`${method} input contains an unsupported field`);
  }
  const params = record(input.params, `${method} params`);
  if (input.invocation === undefined) return { params, context: {} };
  const invocation = record(input.invocation, `${method} invocation`);
  if (Object.entries(invocation).some(([key, field]) => !INVOCATION_KEYS.has(key) || typeof field !== 'string')) {
    throw new TypeError(`${method} invocation contains an unsupported field`);
  }
  return { params, context: { invocation } };
}

function operationInput(value: unknown, method: string, allowMinutes: boolean): Readonly<Record<string, unknown>> {
  const input = record(value, `${method} input`);
  if (Object.keys(input).some((key) => key !== 'input' && (!allowMinutes || key !== 'minutes'))) {
    throw new TypeError(`${method} input contains an unsupported field`);
  }
  record(input.input, `${method} caller input`);
  return input;
}

function statusResult(status: Awaited<ReturnType<WeChatVisibleReaderArmStore['status']>>) {
  return {
    render: 'status',
    data: status,
    label: status.armed ? 'Visible WeChat reading authorized' : 'Visible WeChat reading not authorized',
  };
}

async function activateReader(context: FeatureContext, options: WeChatVisibleReaderPluginModuleOptions) {
  const armStore = new WeChatVisibleReaderArmStore({ storage: context.storage, now: options.now });
  // The former lease was process-local. A new runtime must not inherit an arm
  // left in durable storage by an unclean stop.
  await armStore.disarm();
  const handlers = createWeChatVisibleReaderHandlers({
    armStore,
    metrics: new WeChatVisibleReaderMetrics(),
    runner: options.createRunner?.() ?? createWeChatVisibleReaderNativeRunner(),
  });
  return {
    actions: {
      [VISIBLE_METHOD]: (value: unknown) => {
        const { params, context } = limbInput(value, VISIBLE_METHOD);
        return handlers[VISIBLE_METHOD]!(params, context);
      },
      [RECENT_METHOD]: (value: unknown) => {
        const { params, context } = limbInput(value, RECENT_METHOD);
        return handlers[RECENT_METHOD]!(params, context);
      },
      [ARM_METHOD]: async (value: unknown) => {
        const input = operationInput(value, ARM_METHOD, true);
        return statusResult(await armStore.arm({ minutes: input.minutes as number }));
      },
      [DISARM_METHOD]: async (value: unknown) => {
        operationInput(value, DISARM_METHOD, false);
        return statusResult(await armStore.disarm());
      },
      [STATUS_METHOD]: async (value: unknown) => {
        operationInput(value, STATUS_METHOD, false);
        return statusResult(await armStore.status());
      },
    },
    dispose: () => armStore.disarm().then(() => undefined),
  };
}

export function createWeChatVisibleReaderPluginModule(
  options: WeChatVisibleReaderPluginModuleOptions = {},
): PluginModuleEntrypoint {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'read-visible-wechat': (context) => activateReader(context, options),
    },
  }));
}

export default createWeChatVisibleReaderPluginModule();
