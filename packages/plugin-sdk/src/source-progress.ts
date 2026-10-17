import { assertPluginSourceFact, type PluginSourceFact } from '@clowder-ai/plugin-contract';

export interface PluginQueueProgress {
  readonly status: 'queued' | 'processing' | 'terminal';
  readonly allTargetCats: readonly string[];
  readonly handledByCatIds: readonly string[];
  readonly failedByCatIds: readonly string[];
  readonly seenByCatIds: readonly string[];
  readonly bodyExposures?: readonly { readonly targetCatId: string }[];
  readonly targetOutcomeByCatId?: Readonly<Record<string, { readonly handledAt: number }>>;
}
/** Owner display facts only; neither content nor invocation/execution authority is exposed. */
export type PluginSourceProgressFact = Omit<PluginSourceFact, 'content'> & { readonly queueCustody?: PluginQueueProgress };

function invalid(): never { throw new TypeError('Invalid plugin source progress fact'); }
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !property.enumerable || !('value' in property) || (fields && !fields.includes(key))) invalid();
  }
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string') invalid(); return value; }
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) invalid();
  for (const key of keys) if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) invalid();
  return value;
}
function strings(value: unknown): string[] { return array(value).map(string); }
function queueProgress(value: unknown): PluginQueueProgress {
  const queue = record(value, ['status', 'allTargetCats', 'handledByCatIds', 'failedByCatIds', 'seenByCatIds',
    'bodyExposures', 'targetOutcomeByCatId']);
  const status = queue.status;
  if (status !== 'queued' && status !== 'processing' && status !== 'terminal') invalid();
  return {
    status, allTargetCats: strings(queue.allTargetCats), handledByCatIds: strings(queue.handledByCatIds),
    failedByCatIds: strings(queue.failedByCatIds), seenByCatIds: strings(queue.seenByCatIds),
    ...(queue.bodyExposures === undefined ? {} : { bodyExposures: array(queue.bodyExposures).map(value => {
      const exposure = record(value, ['targetCatId']); return { targetCatId: string(exposure.targetCatId) };
    }) }),
    ...(queue.targetOutcomeByCatId === undefined ? {} : { targetOutcomeByCatId:
      Object.fromEntries(Object.entries(record(queue.targetOutcomeByCatId)).map(([catId, value]) => {
        const outcome = record(value, ['handledAt']);
        if (typeof outcome.handledAt !== 'number' || !Number.isFinite(outcome.handledAt)) invalid();
        return [catId, { handledAt: outcome.handledAt }];
      })) }),
  };
}
export function projectSourceProgress(value: unknown, messageRef: `message:${string}`): PluginSourceProgressFact {
  const fact = record(value, ['id', 'userId', 'threadId', 'catId', 'source', 'extra', 'queueCustody']);
  const { queueCustody, ...identity } = fact;
  // Reuse the existing source identity validation. The local schema-only content field is never returned.
  const schemaIdentity = { ...identity, content: '' };
  assertPluginSourceFact(schemaIdentity);
  if (schemaIdentity.id !== messageRef.slice('message:'.length)) invalid();
  const { content: _schemaOnly, ...result } = schemaIdentity;
  return structuredClone({ ...result, ...(queueCustody === undefined ? {} : { queueCustody: queueProgress(queueCustody) }) });
}
