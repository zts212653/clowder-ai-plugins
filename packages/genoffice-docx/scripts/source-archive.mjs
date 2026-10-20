import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleepDefault } from 'node:timers/promises';

const transientCodes = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
function transient(error) {
  const seen = new Set();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    if (transientCodes.has(error.code) || error.name === 'TimeoutError') return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

// Transport only. The caller still performs digest, archive-entry and extracted
// source admission before consuming anything, including a verified cache hit.
export async function readSourceArchive(archivePath, lock, {
  fetchFn = globalThis.fetch, sleep = sleepDefault, timeoutMs = 30_000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('source timeout must be positive');
  let cached;
  try {
    cached = await readFile(archivePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (cached && createHash('sha256').update(cached).digest('hex') === lock.archiveSha256) return cached;

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('source download timed out', 'TimeoutError')), timeoutMs);
    try {
      const response = await fetchFn(lock.archiveUrl, {
        redirect: 'follow',
        headers: { 'user-agent': 'clowder-ai-genoffice-source-admission/0.1' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`source download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2 || !transient(error)) throw error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(250 * 2 ** attempt);
  }
}
