import { randomUUID } from 'node:crypto';

interface Phrase {
  id: string;
  text: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPhrase(value: unknown): value is Phrase {
  return isRecord(value) && typeof value.id === 'string' && typeof value.text === 'string';
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
    if (!isRecord(input)) return json(400, { error: 'Invalid request' });
    const { method, body, query } = input;
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return json(405, { error: 'Invalid method' });
    if (context.operation !== (method === 'GET' ? 'read' : 'write'))
      return json(403, { error: 'Invalid owner operation' });
    await context.assertCurrent();

    const key = `quick-phrases:${Buffer.from(context.userId).toString('base64url')}`;
    const current = await storage.get(key);
    const phrases = current?.value ?? [];
    if (!Array.isArray(phrases) || !phrases.every(isPhrase)) return json(500, { error: 'Invalid phrase data' });

    if (method === 'GET') {
      const search = isRecord(query) ? query.q : undefined;
      const rawPage = isRecord(query) ? query.page : undefined;
      const requestedPage = typeof rawPage === 'string' && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
      const term = typeof search === 'string' ? search.trim().toLowerCase() : '';
      const matches = term ? phrases.filter((phrase) => phrase.text.toLowerCase().includes(term)) : phrases;
      const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
      const page = Math.min(Math.max(1, requestedPage), totalPages);
      const offset = (page - 1) * pageSize;
      return json(200, { items: matches.slice(offset, offset + pageSize), page, totalPages });
    }

    if (!isRecord(body)) return json(400, { error: 'Invalid phrase' });
    let next: Phrase[];
    if (method === 'POST') {
      const { text } = body;
      if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
        return json(400, { error: 'Phrase must contain 1–100,000 characters' });
      if (phrases.some((phrase) => phrase.text === text)) return json(200, { ok: true });
      next = [{ id: randomUUID(), text }, ...phrases];
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 1024 * 1024)
        return json(413, { error: 'Phrase storage is full' });
    } else {
      const { id } = body;
      if (typeof id !== 'string' || id.length !== 36) return json(400, { error: 'Invalid phrase id' });
      next = phrases.filter((phrase) => phrase.id !== id);
      if (next.length === phrases.length) return json(200, { ok: true });
    }
    await context.assertCurrent();
    const write = await storage.compareAndSet(key, current?.revision ?? null, next);
    return write.applied ? json(200, { ok: true }) : json(409, { error: 'Phrases changed, please retry' });
  };
}
