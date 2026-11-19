import { isAbsolute } from 'node:path';
import {
  MEMORY_PROTOCOL_MAJOR,
  MEMORY_REQUIRED_OPERATIONS,
  MEMORY_STORAGE_FORMAT,
  type MemoryDescriptor,
} from '@clowder-ai/plugin-memory-contract';
import { entityOutputSchemas } from '@clowder-ai/plugin-memory-contract/entity';
import { eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
import { matterOutputSchemas } from '@clowder-ai/plugin-memory-contract/matter';
import { profileOutputSchemas } from '@clowder-ai/plugin-memory-contract/profile';
import {
  definePlugin,
  definePluginModule,
  type ModulePluginHostShape,
  type PluginModuleEntrypoint,
} from '@clowder-ai/plugin-sdk';

import type { MemoryHostPorts } from './host-port.js';
import { openMemoryStorage } from './open-memory-storage.js';
import { dispatchMemory } from './operations/dispatch.js';
import { createEntityDispatch } from './operations/entity.js';
import { dispatchEvent } from './operations/event.js';
import { ThreadKvOperations } from './operations/kv.js';
import { createMatterDispatch } from './operations/matter.js';
import { dispatchProfile } from './operations/profile.js';
import { FileProfileRepository } from './profile/FileProfileRepository.js';
import { ProfileMemoryLifecycleStore } from './profile/ProfileMemoryLifecycleStore.js';

/** The internal admission call made between loading actions and declaring healthy. */
export const MEMORY_DESCRIBE_METHOD = 'memory.describe';

/** The single typed business entry point. */
export const MEMORY_DISPATCH_METHOD = 'memory.dispatch';

function memoryDescriptor(): MemoryDescriptor {
  return {
    protocolMajor: MEMORY_PROTOCOL_MAJOR,
    operations: [
      ...MEMORY_REQUIRED_OPERATIONS,
      ...Object.keys(matterOutputSchemas),
      ...Object.keys(eventOutputSchemas),
      ...Object.keys(profileOutputSchemas),
      ...Object.keys(entityOutputSchemas),
    ],
    storageFormat: MEMORY_STORAGE_FORMAT,
  };
}

function requireMemoryPorts(host: ModulePluginHostShape): MemoryHostPorts {
  const ports = host as ModulePluginHostShape & {
    memoryDatabase?: Partial<MemoryHostPorts['memoryDatabase']>;
    memoryData?: Partial<MemoryHostPorts['memoryData']>;
    memoryThreadKv?: Partial<MemoryHostPorts['memoryThreadKv']>;
    memorySource?: Partial<MemoryHostPorts['memorySource']>;
  };
  for (const [name, methods] of [
    ['memoryThreadKv', ['get', 'list', 'compareAndSet', 'delete']],
    ['memorySource', ['caller', 'assertCurrent', 'publishMatterChange', 'canReadThread', 'readMessage', 'currentTrigger']],
  ] as const) {
    const port = ports[name] as Record<string, unknown> | undefined;
    if (!port || methods.some((method) => typeof port[method] !== 'function')) {
      throw new TypeError(`memory plugin requires the authorized Host ${name} port`);
    }
  }
  const { memoryDatabase, memoryData } = ports;
  if (memoryDatabase?.storageFormat !== MEMORY_STORAGE_FORMAT || !isAbsolute(memoryDatabase.canonicalPath ?? '')) {
    throw new TypeError('memory plugin requires the canonical Host evidence DB and storage format');
  }
  if (
    !isAbsolute(memoryData?.dataDir ?? '') ||
    (memoryData?.eventDbPath !== ':memory:' && !isAbsolute(memoryData?.eventDbPath ?? ''))
  ) {
    throw new TypeError('memory plugin requires the canonical Host Profile and Event data locations');
  }
  return ports as ModulePluginHostShape & MemoryHostPorts;
}

async function activate(ports: MemoryHostPorts) {
  const storage = await openMemoryStorage(ports);
  const { memorySource, memoryData } = ports;
  const kv = new ThreadKvOperations(ports.memoryThreadKv);
  const matter = createMatterDispatch(storage, memorySource);
  const entity = createEntityDispatch(storage, memorySource);
  const profile = new ProfileMemoryLifecycleStore({
    db: storage.db,
    repository: new FileProfileRepository({ dataDir: memoryData.dataDir }),
  });
  return {
    dispose: () => storage.close(),
    actions: {
      // Admission probe. Business-parameter free: a Host must be able to ask
      // "what do you speak?" before it trusts any business call.
      [MEMORY_DESCRIBE_METHOD]: () => memoryDescriptor(),
      [MEMORY_DISPATCH_METHOD]: (input: unknown) => {
        const operation = (input as { operation?: unknown } | null)?.operation;
        if (typeof operation === 'string') {
          if (operation.startsWith('matter.')) return matter(input);
          if (operation.startsWith('event.')) return dispatchEvent(storage.events, memorySource, input);
          if (operation.startsWith('profile.')) return dispatchProfile(profile, storage, memorySource, input);
          if (operation.startsWith('entity.')) return entity(input);
        }
        return dispatchMemory(kv, input);
      },
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
            memory: () => activate(requireBoundPorts(ports)),
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
