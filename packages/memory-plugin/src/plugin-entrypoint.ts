import { isAbsolute } from 'node:path';
import {
  MEMORY_PROTOCOL_MAJOR,
  MEMORY_REQUIRED_OPERATIONS,
  MEMORY_SEARCH_OPERATIONS,
  MEMORY_STORAGE_FORMAT,
  type MemoryDescriptor,
} from '@clowder-ai/plugin-memory-contract';
import { entityOutputSchemas } from '@clowder-ai/plugin-memory-contract/entity';
import { eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
import { memoryProjectIndexResponses } from '@clowder-ai/plugin-memory-contract/maintenance';
import { matterOutputSchemas } from '@clowder-ai/plugin-memory-contract/matter';
import { profileOutputSchemas } from '@clowder-ai/plugin-memory-contract/profile';
import { tasteBrowseOutputSchemas } from '@clowder-ai/plugin-memory-contract/taste';
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
import { dispatchIndexStatus } from './operations/index-status.js';
import { ThreadKvOperations } from './operations/kv.js';
import { createMatterDispatch } from './operations/matter.js';
import { dispatchProfile } from './operations/profile.js';
import { dispatchProjectIndex } from './operations/project-index-state.js';
import {
  dispatchCueInvocation,
  dispatchRecallCandidate,
  dispatchRecallEvent,
  dispatchRecallStats,
  dispatchRecallTimeline,
} from './operations/recall-read.js';
import { SearchOperations } from './operations/search.js';
import { createTasteDispatch } from './operations/taste.js';
import { FileProfileRepository } from './profile/FileProfileRepository.js';
import { ProfileMemoryLifecycleStore } from './profile/ProfileMemoryLifecycleStore.js';

/** The internal admission call made between loading actions and declaring healthy. */
export const MEMORY_DESCRIBE_METHOD = 'memory.describe';

/** The single typed business entry point. */
export const MEMORY_DISPATCH_METHOD = 'memory.dispatch';

function memoryDescriptor(tasteReady: boolean): MemoryDescriptor {
  return {
    protocolMajor: MEMORY_PROTOCOL_MAJOR,
    operations: [
      ...MEMORY_REQUIRED_OPERATIONS,
      ...MEMORY_SEARCH_OPERATIONS,
      'index.status',
      'recall.stats',
      'recall.timeline',
      'recall.event',
      'recall.candidate',
      'cue.invocation',
      ...Object.keys(memoryProjectIndexResponses),
      ...Object.keys(matterOutputSchemas),
      ...Object.keys(eventOutputSchemas),
      ...Object.keys(profileOutputSchemas),
      ...Object.keys(entityOutputSchemas),
      ...(tasteReady ? Object.keys(tasteBrowseOutputSchemas) : []),
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
    (memoryData?.eventDbPath !== ':memory:' && !isAbsolute(memoryData?.eventDbPath ?? '')) ||
    (memoryData?.tasteProjectRoot !== undefined && !isAbsolute(memoryData.tasteProjectRoot))
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
  const taste = memoryData.tasteProjectRoot && createTasteDispatch(storage.db, memoryData.tasteProjectRoot, memorySource);
  const profile = new ProfileMemoryLifecycleStore({
    db: storage.db,
    repository: new FileProfileRepository({ dataDir: memoryData.dataDir }),
  });
  const search = new SearchOperations(storage.db);
  const projectIndexClaims = new Set<string>();
  return {
    dispose: () => storage.close(),
    actions: {
      // Admission probe. Business-parameter free: a Host must be able to ask
      // "what do you speak?" before it trusts any business call.
      [MEMORY_DESCRIBE_METHOD]: () => memoryDescriptor(Boolean(taste)),
      [MEMORY_DISPATCH_METHOD]: (input: unknown) => {
        const operation = (input as { operation?: unknown } | null)?.operation;
        if (typeof operation === 'string') {
          if (operation === 'index.status') return dispatchIndexStatus(storage.db, input);
          if (operation === 'recall.stats') return dispatchRecallStats(storage.db, input);
          if (operation === 'recall.timeline') return dispatchRecallTimeline(storage.db, memorySource, input);
          if (operation === 'recall.event') return dispatchRecallEvent(storage.db, input);
          if (operation === 'recall.candidate') return dispatchRecallCandidate(storage.db, input);
          if (operation === 'cue.invocation') return dispatchCueInvocation(storage.db, memorySource, input);
          if (operation.startsWith('index.project.')) {
            return dispatchProjectIndex(storage, projectIndexClaims, () => memorySource.assertCurrent(), input);
          }
          if (operation.startsWith('matter.')) return matter(input);
          if (operation.startsWith('event.')) return dispatchEvent(storage.events, memorySource, input);
          if (operation.startsWith('profile.')) return dispatchProfile(profile, storage, memorySource, input);
          if (operation.startsWith('entity.')) return entity(input);
          if (operation.startsWith('taste.') && taste) return taste(input);
        }
        return dispatchMemory(kv, search, input);
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
