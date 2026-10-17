import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProjectWorkspace } from '../src/projects.mjs';
import { setGithubToken } from '../src/github-auth.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { migrationRuntime, workbenchServer } from './transfer-runtime-fixture.mjs';

for (const lost of [null, 'issue', 'pr']) {
  test(
    `full migration preserves original objects and resumes without duplicate creations (${lost ?? 'waiting-review'})`,
    { timeout: 240000 },
    async (t) => {
      const f = await migrationRuntime(t, lost),
        source = await workbenchServer(t, f.projects);
      setIssueToken(f.receiver.config, 'source-token', 'source-test');
      const original = await source.task({ action: 'synchronize', requestId: 'a'.repeat(32) });
      assert.equal(
        original.status,
        lost ? 'FAILED' : 'SUCCEEDED',
        JSON.stringify({ error: original.error, fixture: f.state.errors }),
      );
      let current = await source.status();
      const runId = current.state.automation.id,
        deliveryId = current.state.active.id;
      const exported = await source.request('/api/transfers/export', {
        kind: 'migration',
        projectId: 'default',
        expectedBinding: current.config.bindingId,
        expectedRevision: current.connection.revision,
      });
      assert.equal(exported.status, 200, JSON.stringify(exported.value));
      const pkg = exported.value,
        raw = JSON.stringify(pkg);
      assert.ok(!raw.includes('source-token'));
      assert.equal((await source.status()).transfer.status, 'EXPORTED');
      await assert.rejects(f.receiver.prepare(), { code: 'TRANSFER_ACTIVATION_REQUIRED' });
      const folder = await mkdtemp(join(tmpdir(), 'repo-sync-migrated-runtime-')),
        file = join(folder, 'config.json');
      let projects = await createProjectWorkspace(file, { allowLocalTransfers: true });
      let target = await workbenchServer(t, projects);
      assert.equal((await target.request('/api/transfers/preview', pkg)).status, 200);
      const input = {
        packageId: pkg.packageId,
        name: '迁入项目',
        projectId: 'default',
        expectedWorkspaceRevision: null,
      };
      const imported = await target.request('/api/transfers/import', input);
      assert.equal(imported.status, 200, JSON.stringify(imported.value));
      const id = imported.value.project.id;
      assert.deepEqual((await target.request('/api/transfers/import', input)).value.project, imported.value.project);
      current = await target.status(id);
      assert.equal(current.state.active.id, deliveryId);
      assert.equal(current.state.automation.id, runId);
      assert.equal(current.state.automation.status, 'PAUSED');
      assert.deepEqual(current.state.active.commitMappings, (await source.status()).state.active.commitMappings);
      const scope = () => ({
        expectedRevision: current.connection.revision,
        expectedBinding: current.config.bindingId,
        projectId: id,
      });
      let checked = await target.request('/api/transfers/check', scope(), id);
      assert.ok(checked.value.transfer.checks.some((c) => c.key === 'platform-auth' && c.status === 'FAILED'));
      const before = [f.state.issueCreates, f.state.prCreates];
      await target.server.shutdown();
      projects = await createProjectWorkspace(file, { allowLocalTransfers: true });
      target = await workbenchServer(t, projects);
      current = await target.status(id);
      assert.equal(current.transfer.status, 'IMPORTED');
      assert.deepEqual([f.state.issueCreates, f.state.prCreates], before);
      const connection = await projects.connection(id),
        receiver = await connection.current();
      assert.equal(
        (await readFile(join(receiver.config.stateDir, 'operations', `${original.id}.json`), 'utf8')).includes(
          original.id,
        ),
        true,
      );
      setIssueToken(receiver.config, 'recipient-token', 'recipient-test');
      setGithubToken(receiver.config, 'recipient-github-token', 'recipient-test');
      const activated = await target.request('/api/transfers/activate', { ...scope(), confirmSingleWriter: true }, id);
      assert.equal(activated.value.activated, true, JSON.stringify(activated.value));
      assert.equal((await target.status(id)).state.automation.status, 'PAUSED');
      if (lost) {
        const retried = await target.task({ action: 'resume-sync', runId, requestId: 'b'.repeat(32) }, id);
        assert.equal(retried.status, 'SUCCEEDED', JSON.stringify({ error: retried.error, fixture: f.state.errors }));
      }
      current = await target.status(id);
      assert.equal(current.state.active.status, 'WAITING_APPROVAL');
      assert.equal(f.state.issueCreates, 1);
      assert.equal(f.state.prCreates, 1);
      await f.merge(current.state.active);
      const settled = await target.task({ action: 'resume-sync', runId, requestId: 'c'.repeat(32) }, id);
      assert.equal(settled.status, 'SUCCEEDED', JSON.stringify(settled.error));
      current = await target.status(id);
      assert.equal(current.state.deliveries[0].status, 'COMPLETE');
      assert.equal(current.state.automation.status, 'PAUSED');
      assert.equal(current.state.active, undefined);
      assert.equal(f.state.issueCreates, 1);
      assert.equal(f.state.prCreates, 1);
      const next = await target.task({ action: 'resume-sync', runId, requestId: 'd'.repeat(32) }, id);
      assert.equal(next.status, 'SUCCEEDED', JSON.stringify(next.error));
      current = await target.status(id);
      await f.merge(current.state.active);
      const done = await target.task({ action: 'resume-sync', runId, requestId: 'e'.repeat(32) }, id);
      assert.equal(done.status, 'SUCCEEDED', JSON.stringify(done.error));
      current = await target.status(id);
      assert.equal(current.state.deliveries.length, 2);
      assert.equal(current.state.issues['issue-71'].state, 'closed');
      assert.equal(f.state.issueCreates, 1);
      assert.equal(f.state.prCreates, 2);
      assert.equal(f.state.closes, 1);
    },
  );
}
