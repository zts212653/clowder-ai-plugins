import { createHash } from 'node:crypto';
import { type MemoryProjectIndexState, memoryProjectIndexRequest } from '@clowder-ai/plugin-memory-contract/maintenance';
import type { openMemoryStorage } from '../open-memory-storage.js';

export function dispatchProjectIndex(
  storage: Awaited<ReturnType<typeof openMemoryStorage>>,
  activeClaims: Set<string>,
  assertCurrent: () => Promise<void>,
  request: unknown,
) {
  const action = memoryProjectIndexRequest.parse(request);
  const { db } = storage;
  const { projectPath } = action.input;
  const state = db.prepare<[string], MemoryProjectIndexState>('SELECT * FROM index_state WHERE project_path = ?');
  if (action.operation === 'index.project.read') {
    const row = state.get(projectPath);
    if (!row) {
      return {
        id: '',
        project_path: projectPath,
        status: 'missing',
        fingerprint: '',
        last_scan_at: null,
        snoozed_until: null,
        docs_indexed: 0,
        docs_total: 0,
        error_message: null,
        summary_json: null,
        created_at: '',
        updated_at: '',
      } satisfies MemoryProjectIndexState;
    }
    const { fingerprint } = action.input;
    if (row.status === 'building' && !activeClaims.has(projectPath)) return { ...row, status: 'stale' };
    return fingerprint && row.status === 'ready' && row.fingerprint !== fingerprint ? { ...row, status: 'stale' } : row;
  }

  return storage.runWrite(async () => {
    await assertCurrent();
    const now = new Date().toISOString();
    if (action.operation === 'index.project.claim') {
      const { fingerprint } = action.input;
      const current = state.get(projectPath);
      if (current?.snoozed_until && new Date(current.snoozed_until) > new Date(now)) return false;
      if (activeClaims.has(projectPath) || (current?.status === 'ready' && (!fingerprint || current.fingerprint === fingerprint))) {
        return false;
      }
      const id = createHash('sha256').update(projectPath).digest('hex');
      db.prepare(`
        INSERT INTO index_state (id, project_path, status, fingerprint, created_at, updated_at)
        VALUES (?, ?, 'building', ?, ?, ?)
        ON CONFLICT(project_path) DO UPDATE SET status = 'building', fingerprint = excluded.fingerprint,
          error_message = NULL, updated_at = excluded.updated_at
      `).run(id, projectPath, fingerprint, now, now);
      activeClaims.add(projectPath);
      return true;
    }
    if (action.operation === 'index.project.snooze') {
      const id = createHash('sha256').update(projectPath).digest('hex');
      const until = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO index_state (id, project_path, status, snoozed_until, created_at, updated_at)
        VALUES (?, ?, 'missing', ?, ?, ?)
        ON CONFLICT(project_path) DO UPDATE SET snoozed_until = excluded.snoozed_until, updated_at = excluded.updated_at
      `).run(id, projectPath, until, now, now);
      return until;
    }
    if (action.input.status === 'ready') {
      db.prepare(`
        UPDATE index_state SET status = 'ready', docs_indexed = ?, summary_json = ?, last_scan_at = ?,
          error_message = NULL, updated_at = ? WHERE project_path = ?
      `).run(action.input.docsIndexed, action.input.summaryJson, now, now, projectPath);
    } else {
      db.prepare(`UPDATE index_state SET status = 'failed', error_message = ?, updated_at = ? WHERE project_path = ?`)
        .run(action.input.error, now, projectPath);
    }
    activeClaims.delete(projectPath);
    return null;
  });
}
