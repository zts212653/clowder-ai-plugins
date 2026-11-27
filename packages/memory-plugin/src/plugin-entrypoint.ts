import { memoryDescriptor } from '@clowder-ai/plugin-memory-contract';
import {
  definePlugin,
  definePluginModule,
  type FeatureContext,
  type ModulePluginHostShape,
  type PluginModuleEntrypoint,
} from '@clowder-ai/plugin-sdk';

import type { MemoryDatabasePort, MemoryHostPorts, MemoryThreadKvPort } from './host-port.js';
import { dispatchMemory } from './operations/dispatch.js';
import { ThreadKvOperations } from './operations/kv.js';
import { SearchOperations } from './operations/search.js';

/** The internal admission call made between loading actions and declaring healthy. */
export const MEMORY_DESCRIBE_METHOD = 'memory.describe';

/** The single typed business entry point. */
export const MEMORY_DISPATCH_METHOD = 'memory.dispatch';

/**
 * The Host fields this plugin reads, declared here because the published SDK type
 * predates them. Reading named fields is the boundary check; everything below
 * receives already-typed ports.
 */
type HostWithMemoryPorts = ModulePluginHostShape & {
  readonly memoryThreadKv?: unknown;
  readonly memoryDatabase?: unknown;
};

/**
 * Accept the Host ports once, at the boundary.
 *
 * A Host that does not supply them is not compatible, and saying so is the only
 * truthful answer: degrading to an empty store would look healthy on both sides
 * while hiding every existing record.
 */
function requireMemoryPorts(host: ModulePluginHostShape): MemoryHostPorts {
  const memoryThreadKv = (host as HostWithMemoryPorts).memoryThreadKv;
  if (memoryThreadKv === null || typeof memoryThreadKv !== 'object') {
    throw new TypeError('memory plugin requires the authorized Host memoryThreadKv port');
  }
  const shaped = memoryThreadKv as Record<string, unknown>;
  for (const method of ['get', 'list', 'compareAndSet', 'delete'] as const) {
    if (typeof shaped[method] !== 'function') {
      throw new TypeError(`memory plugin memoryThreadKv port must supply ${method}`);
    }
  }
  const database = (host as HostWithMemoryPorts).memoryDatabase;
  if (database === null || typeof database !== 'object') {
    throw new TypeError('memory plugin requires the Host memoryDatabase coordinate');
  }
  const coordinate = database as Record<string, unknown>;
  if (typeof coordinate.canonicalPath !== 'string' || coordinate.canonicalPath.length === 0) {
    throw new TypeError('memory plugin memoryDatabase port must supply canonicalPath');
  }
  return {
    memoryThreadKv: memoryThreadKv as MemoryThreadKvPort,
    memoryDatabase: database as MemoryDatabasePort,
  };
}

function activate(context: FeatureContext, ports: MemoryHostPorts) {
  const kv = new ThreadKvOperations(ports.memoryThreadKv);
  const search = new SearchOperations(ports.memoryDatabase);
  return {
    actions: {
      // Admission probe. Business-parameter free: a Host must be able to ask
      // "what do you speak?" before it trusts any business call.
      [MEMORY_DESCRIBE_METHOD]: () => memoryDescriptor(),
      [MEMORY_DISPATCH_METHOD]: (input: unknown) => dispatchMemory(kv, search, input),
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
            memory: (context: FeatureContext) => activate(context, requireBoundPorts(ports)),
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

function requireBoundPorts(ports: MemoryHostPorts | undefined): MemoryHostPorts {
  if (ports === undefined) {
    throw new TypeError('memory plugin requires Host-supplied authorized memory ports');
  }
  return ports;
}

export default createMemoryPluginModule();
