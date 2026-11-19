import { parseDispatch } from '@clowder-ai/plugin-memory-contract';

import type { ThreadKvOperations } from './kv.js';
import type { SearchOperations } from './search.js';

/**
 * The single typed business entry point.
 *
 * The operation discriminator and its input are parsed once here, at the
 * boundary; every branch below receives an already-typed request.
 */
export function dispatchMemory(
  kv: ThreadKvOperations,
  search: SearchOperations,
  value: unknown,
): Promise<unknown> {
  const request = parseDispatch(value);
  switch (request.operation) {
    case 'kv.put':
      return kv.put(request.input);
    case 'kv.get':
      return kv.get(request.input);
    case 'kv.list':
      return kv.list(request.input);
    case 'kv.delete':
      return kv.delete(request.input);
    case 'search.query':
      return search.query(request.input);
  }
}
