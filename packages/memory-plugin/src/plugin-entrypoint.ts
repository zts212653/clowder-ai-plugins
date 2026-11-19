import {
  MEMORY_PROTOCOL_MAJOR,
  MEMORY_REQUIRED_OPERATIONS,
  MEMORY_STORAGE_FORMAT,
  type MemoryDescriptor,
} from '@clowder-ai/plugin-memory-contract';
import {
  definePlugin,
  definePluginModule,
  type FeatureContext,
  type ModulePluginHostShape,
  type PluginModuleEntrypoint,
} from '@clowder-ai/plugin-sdk';

import type { MemoryHostPorts } from './host-port.js';
import { dispatchMemory } from './operations/dispatch.js';
import { ThreadKvOperations } from './operations/kv.js';

/** The internal admission call made between loading actions and declaring healthy. */
export const MEMORY_DESCRIBE_METHOD = 'memory.describe';

/** The single typed business entry point. */
export const MEMORY_DISPATCH_METHOD = 'memory.dispatch';

function memoryDescriptor(): MemoryDescriptor {
  return {
    protocolMajor: MEMORY_PROTOCOL_MAJOR,
    operations: [...MEMORY_REQUIRED_OPERATIONS],
    storageFormat: MEMORY_STORAGE_FORMAT,
  };
}

/**
 * Accept the Host ports once, at the boundary. A Host that does not supply them
 * is not compatible, and saying so is the only truthful answer: degrading to an
 * empty store would look healthy while hiding every existing record.
 */
function requireMemoryPorts(host: ModulePluginHostShape): MemoryHostPorts {
  const candidate = (host as ModulePluginHostShape & { memoryPorts?: unknown }).memoryPorts;
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('memory plugin requires Host-supplied authorized memory ports');
  }
  const port = (candidate as { threadKv?: unknown }).threadKv;
  if (port === null || typeof port !== 'object') {
    throw new TypeError('memory plugin requires the authorized Host threadKv port');
  }
  const shaped = port as { readAll?: unknown; write?: unknown; remove?: unknown };
  if (
    typeof shaped.readAll !== 'function' ||
    typeof shaped.write !== 'function' ||
    typeof shaped.remove !== 'function'
  ) {
    throw new TypeError('memory plugin threadKv port must supply readAll, write and remove');
  }
  return candidate as MemoryHostPorts;
}

function activate(context: FeatureContext, ports: MemoryHostPorts) {
  const kv = new ThreadKvOperations(ports.threadKv);
  return {
    actions: {
      // Admission probe. Business-parameter free: a Host must be able to ask
      // "what do you speak?" before it trusts any business call.
      [MEMORY_DESCRIBE_METHOD]: () => memoryDescriptor(),
      [MEMORY_DISPATCH_METHOD]: (input: unknown) => dispatchMemory(kv, input),
    },
  };
}

export function createMemoryPluginModule(): PluginModuleEntrypoint {
  return {
    create: (manifest) => {
      // Ports are bound per created definition, never shared across
      // installations: a second Host must not inherit the first Host's grant.
      let ports: MemoryHostPorts | undefined;
      const definition = definePluginModule(() =>
        definePlugin({
          manifest,
          activate: {
            memory: (context: FeatureContext) =>
              activate(context, ports ?? failClosed('memory plugin requires Host-supplied authorized memory ports')),
          },
        }),
      ).create(manifest);
      return {
        ...definition,
        start: (host) => {
          ports = requireMemoryPorts(host);
          return definition.start(host);
        },
      };
    },
  };
}

function failClosed(reason: string): never {
  throw new TypeError(reason);
}

export default createMemoryPluginModule();
