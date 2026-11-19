/**
 * @clowder-ai/memory-plugin
 *
 * The official Clowder AI memory plugin. It owns thread KV, evidence retrieval
 * and memory business rules; the Host owns identity, authorization, canonical
 * sources and the physical storage roots it hands over through authorized ports.
 *
 * @packageDocumentation
 */

export {
  MEMORY_DESCRIBE_METHOD,
  MEMORY_DISPATCH_METHOD,
  createMemoryPluginModule,
} from './plugin-entrypoint.js';
export { MAX_KEYS_PER_THREAD, ThreadKvOperations } from './operations/kv.js';
export { dispatchMemory } from './operations/dispatch.js';
export { readEntry, type MemoryHostPorts, type MemoryThreadKvPort } from './host-port.js';
export { default } from './plugin-entrypoint.js';
