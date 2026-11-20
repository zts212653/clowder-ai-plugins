import { randomUUID } from 'node:crypto';

interface Phrase {
  id: string;
  text: string;
  useCount?: number;
}

export interface PhraseStorage {
  get(key: string): Promise<{ revision: number; value: unknown } | undefined>;
  compareAndSet(key: string, revision: number | null, value: Phrase[]): Promise<{ applied: boolean }>;
}

export interface OwnerContext {
  kind: 'owner-http-request';
  userId: string;
  pluginInstanceId: string;
  operation: 'read' | 'write';
  assertCurrent(): Promise<void>;
}

const pageSize = 5;
const usageAttempts = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPhrase(value: unknown): value is Phrase {
  return isRecord(value) && typeof value.id === 'string' && typeof value.text === 'string'
    && (value.useCount === undefined
      || (typeof value.useCount === 'number' && Number.isInteger(value.useCount) && value.useCount >= 0));
}

function parsePhrases(current: { revision: number; value: unknown } | undefined): Phrase[] | undefined {
  const phrases = current?.value ?? [];
  return Array.isArray(phrases) && phrases.every(isPhrase) ? phrases : undefined;
}

function json(status: number, payload: object) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

export function createQuickPhrases(storage: PhraseStorage) {
  return async (input: unknown, context: OwnerContext | undefined) => {
    if (context?.kind !== 'owner-http-request') return json(403, { error: 'Owner request required' });
    if (!isRecord(input) || !isRecord(input.request)) return json(400, { error: 'Invalid request' });
    const { method, body, query } = input.request;
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return json(405, { error: 'Invalid method' });
    if (context.operation !== (method === 'GET' ? 'read' : 'write'))
      return json(403, { error: 'Invalid owner operation' });
    await context.assertCurrent();

    const key = `quick-phrases:${Buffer.from(context.userId).toString('base64url')}`;
    if (method === 'GET') {
      const phrases = parsePhrases(await storage.get(key));
      if (!phrases) return json(500, { error: 'Invalid phrase data' });
      const search = isRecord(query) ? query.q : undefined;
      const rawPage = isRecord(query) ? query.page : undefined;
      const requestedPage = typeof rawPage === 'string' && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
      const term = typeof search === 'string' ? search.trim().toLowerCase() : '';
      const matches = phrases
        .filter((phrase) => !term || phrase.text.toLowerCase().includes(term))
        .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
      const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
      const page = Math.min(Math.max(1, requestedPage), totalPages);
      const offset = (page - 1) * pageSize;
      return json(200, {
        items: matches.slice(offset, offset + pageSize),
        page,
        totalPages,
        paged: totalPages > 1,
        first: page <= 1,
        last: page >= totalPages,
        prevPage: Math.max(1, page - 1),
        nextPage: Math.min(totalPages, page + 1),
      });
    }

    if (!isRecord(body)) return json(400, { error: 'Invalid phrase' });
    if (method === 'POST' && 'id' in body && 'text' in body)
      return json(400, { error: 'Provide either a phrase id or text' });

    if (method === 'POST' && 'id' in body) {
      const { id } = body;
      if (typeof id !== 'string' || id.length !== 36) return json(400, { error: 'Invalid phrase id' });
      const phrase = parsePhrases(await storage.get(key))?.find((item) => item.id === id);
      if (!phrase) return json(404, { error: 'Phrase not found' });
      // The text goes into the input whatever happens to the usage count (the count is a receipt, not a gate).
      const insert = json(200, { ok: true, act: 'insert', args: { into: 'chat-input', text: phrase.text } });
      for (let attempt = 0; attempt < usageAttempts; attempt++) {
        // A failed read or write only leaves the count as it is; a cancelled request still fails at assertCurrent.
        const current = await storage.get(key).catch(() => undefined);
        const phrases = parsePhrases(current);
        if (!phrases?.some((item) => item.id === id)) return insert;
        const next = phrases.map((item) => (item.id === id ? { ...item, useCount: (item.useCount ?? 0) + 1 } : item));
        if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 1024 * 1024) return insert;
        await context.assertCurrent();
        const write = await storage.compareAndSet(key, current?.revision ?? null, next).catch(() => undefined);
        // Only an unapplied CAS is safe to retry (a failed write may have landed); a fresh read makes the next attempt count once.
        if (write?.applied !== false) return insert;
      }
      return insert;
    }

    const current = await storage.get(key);
    const phrases = parsePhrases(current);
    if (!phrases) return json(500, { error: 'Invalid phrase data' });
    let next: Phrase[];
    if (method === 'POST') {
      const { text } = body;
      if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
        return json(400, { error: 'Phrase must contain 1–100,000 characters' });
      if (phrases.some((phrase) => phrase.text === text)) return json(200, { ok: true, act: 'plugSet', args: { plugin: 'official.quick-phrases', k: 'page', v: 1 } });
      next = [{ id: randomUUID(), text, useCount: 0 }, ...phrases];
    } else {
      const { id } = body;
      if (typeof id !== 'string' || id.length !== 36) return json(400, { error: 'Invalid phrase id' });
      next = phrases.filter((phrase) => phrase.id !== id);
      if (next.length === phrases.length) return json(200, { ok: true });
    }
    if (method === 'POST' && Buffer.byteLength(JSON.stringify(next), 'utf8') > 1024 * 1024)
      return json(413, { error: 'Phrase storage is full' });
    await context.assertCurrent();
    const write = await storage.compareAndSet(key, current?.revision ?? null, next);
    return write.applied ? json(200, { ok: true, ...(method === 'POST' ? { act: 'plugSet', args: { plugin: 'official.quick-phrases', k: 'page', v: 1 } } : {}) }) : json(409, { error: 'Phrases changed, please retry' });
  };
}
