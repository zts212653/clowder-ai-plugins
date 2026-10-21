import type { LegacyReadPort, LegacySourceScope } from './operational-source.js';

export const taskFields = [
  'id',
  'kind',
  'threadId',
  'subjectKey',
  'userId',
  'ownerCatId',
  'status',
  'title',
  'why',
  'createdBy',
  'createdAt',
  'updatedAt',
  'automationState',
] as const;
export function identifier(value: string) {
  if (!/^[A-Za-z0-9_.@-]{1,200}$/.test(value)) throw new Error('Invalid scoped identity');
  return value;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) throw new Error('Invalid source index');
  return value as string[];
}
export function scalar(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw new Error('Invalid source scalar');
  return value;
}
export function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid source count');
  return value;
}
export function json(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid legacy source JSON');
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source record');
  return value as Record<string, unknown>;
}
export async function hash(
  reader: LegacyReadPort,
  key: string,
  fields: readonly string[],
): Promise<Record<string, string>> {
  const raw = await reader.read('HMGET', key, ...fields);
  if (!Array.isArray(raw) || raw.length !== fields.length) throw new Error('Incomplete source hash read');
  return Object.fromEntries(
    fields.flatMap((field, i) => {
      const value = scalar(raw[i]);
      return value === null ? [] : [[field, value]];
    }),
  );
}
export async function ownedThread(reader: LegacyReadPort, scope: LegacySourceScope, id: string) {
  return (
    scalar(await reader.read('HGET', scope.keyPrefix + 'thread:' + identifier(id), 'createdBy')) === scope.ownerUserId
  );
}
export async function scan(reader: LegacyReadPort, prefix: string, match: string, setKey?: string) {
  const found = new Set<string>();
  let cursor = '0',
    pages = 0;
  do {
    const raw = setKey
      ? await reader.read('SSCAN', prefix + setKey, cursor, 'MATCH', match, 'COUNT', '256')
      : await reader.read('SCAN', cursor, 'MATCH', prefix + match, 'COUNT', '256');
    if (!Array.isArray(raw) || typeof raw[0] !== 'string' || !/^[0-9]+$/.test(raw[0]))
      throw new Error('Invalid source scan');
    cursor = raw[0];
    for (const value of strings(raw[1])) {
      if (!setKey && !value.startsWith(prefix)) throw new Error('Source prefix escaped');
      found.add(setKey ? value : value.slice(prefix.length));
    }
    if (++pages > 2000 || found.size > 20000) throw new Error('Source enumeration exceeds bounded scope');
  } while (cursor !== '0');
  return [...found].sort();
}
