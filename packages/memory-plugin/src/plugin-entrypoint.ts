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

import type { MemoryHostPorts, MemoryThreadKvPort } from './host-port.js';
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
 * The Host field this plugin reads, declared here because the published SDK type
 * predates it. Reading one named field is the boundary check; everything below
 * receives an already-typed port.
 */
type HostWithMemoryThreadKv = ModulePluginHostShape & { readonly memoryThreadKv?: unknown };

/**
 * Accept the Host ports once, at the boundary.
 *
 * A Host that does not supply them is not compatible, and saying so is the only
 * truthful answer: degrading to an empty store would look healthy on both sides
 * while hiding every existing record.
 */
function requireMemoryPorts(host: ModulePluginHostShape): MemoryHostPorts {
  const memoryThreadKv = (host as HostWithMemoryThreadKv).memoryThreadKv;
  if (memoryThreadKv === null || typeof memoryThreadKv !== 'object') {
    throw new TypeError('memory plugin requires the authorized Host memoryThreadKv port');
  }
  const shaped = memoryThreadKv as Record<string, unknown>;
  for (const method of ['get', 'list', 'compareAndSet', 'delete'] as const) {
    if (typeof shaped[method] !== 'function') {
      throw new TypeError(`memory plugin memoryThreadKv port must supply ${method}`);
    }
  }
  return { memoryThreadKv: memoryThreadKv as MemoryThreadKvPort };
}

function activate(context: FeatureContext, ports: MemoryHostPorts) {
  const kv = new ThreadKvOperations(ports.memoryThreadKv);
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
