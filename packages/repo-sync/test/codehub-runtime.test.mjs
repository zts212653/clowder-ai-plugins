import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createProjectWorkspace } from '../src/projects.mjs';
import { writePrivate } from '../src/private-config.mjs';
import { git } from '../src/process.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';
import { workbenchServer } from './transfer-runtime-fixture.mjs';

for (const lost of [null, 'issue', 'link', 'close']) {
  test(
    `CodeHub real Git workflow resumes a shared Issue after ${lost ?? 'normal flow'}`,
    { timeout: 240000 },
    async (t) => {
      const f = await repositories(),
        platform = await codehubPlatform(f, { lost }),
        folder = await mkdtemp(join(tmpdir(), 'repo-sync-codehub-runtime-')),
        file = join(folder, 'config.json'),
        adapter = { mode: 'gitlab', apiUrl: platform.api, projectId: 'innersource/team_G/core', authMode: 'session' };
      t.after(platform.close);
      await writePrivate(file, {
        ...f.config,
        stateDir: join(folder, 'state'),
        internalWebUrl: platform.web,
        issues: adapter,
        pullRequests: { ...adapter },
        configurationSource: 'workbench',
      });
      let projects = await createProjectWorkspace(file),
        connection = await projects.connection(),
        receiver = await connection.current(),
        workbench = await workbenchServer(t, projects);
      setIssueToken(receiver.config, platform.token, 'codehub-fixture');
      await receiver.adopt(f.u0, f.i0);
      await receiver.setQueue(f.plans);
      let serial = 0;
      const task = async (action, runId) =>
        workbench.task({
          action,
          ...(runId ? { runId } : {}),
          ...(action === 'synchronize' ? { continuation: 'after-each' } : {}),
          requestId: (++serial).toString(16).padStart(32, '0'),
        });
      const restart = async () => {
        const before = { ...platform.state.creates },
          links = platform.state.links,
          closes = platform.state.closes;
        await workbench.server.shutdown();
        projects = await createProjectWorkspace(file);
        connection = await projects.connection();
        receiver = await connection.current();
        workbench = await workbenchServer(t, projects);
        setIssueToken(receiver.config, platform.token, 'codehub-fixture-restarted');
        assert.deepEqual(platform.state.creates, before, 'restart cannot create objects');
        assert.equal(platform.state.links, links);
        assert.equal(platform.state.closes, closes);
      };
      let result = await task('synchronize');
      const runId = (await workbench.status()).state.automation.id;
      if (lost === 'issue' || lost === 'link') {
        assert.equal(result.status, 'FAILED', JSON.stringify(result));
        assert.equal(platform.state.lost, null, 'fixture must lose the configured applied write');
        const activeId = (await workbench.status()).state.active.id;
        await restart();
        assert.equal((await workbench.status()).state.active.id, activeId);
        result = await task('resume-sync', runId);
      }
      assert.equal(result.status, 'SUCCEEDED', JSON.stringify({ error: result.error, fixture: platform.state.errors }));
      assert.equal(platform.state.creates.issues, 1);
      for (let number = 1; number <= 2; number++) {
        const current = await workbench.status(),
          active = current.state.active;
        assert.equal(current.state.automation.status, 'WAITING_REVIEW');
        assert.equal(active.prUrl, `${platform.web}/merge_requests/${number}`);
        assert.equal(
          platform.state.issues[0].state,
          'opened',
          'shared Issue stays open until both required commits merge',
        );
        assert.equal(platform.state.creates.prs, number);
        assert.equal(platform.state.links, number, 'one durable association write per original PR');
        const mr = platform.state.mrs.find((entry) => entry.sha === active.candidate);
        assert.ok(mr.description.includes('Related to #1'));
        assert.ok(mr.description.includes('[repo-sync-link:'));
        await restart();
        assert.equal((await workbench.status()).state.active.id, active.id);
        await f.merge(active);
        mr.state = 'merged';
        result = await task('resume-sync', runId);
        if (lost === 'close' && number === 2) {
          assert.equal(result.status, 'FAILED', JSON.stringify(result));
          assert.equal(platform.state.issues[0].state, 'closed');
          assert.equal(platform.state.closes, 1);
          await restart();
          result = await task('resume-sync', runId);
        }
        assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result.error));
        const settled = (await workbench.status()).state;
        assert.equal(settled.deliveries[number - 1].status, 'COMPLETE');
        assert.equal(settled.active, undefined);
        if (number === 1) {
          assert.equal(settled.automation.status, 'PAUSED');
          assert.equal(platform.state.issues[0].state, 'opened');
          assert.equal(platform.state.closes, 0);
          result = await task('resume-sync', runId);
          assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result.error));
        }
      }
      await restart();
      result = await task('resume-sync', runId);
      assert.equal(result.status, 'SUCCEEDED');
      const final = (await workbench.status()).state;
      assert.equal(final.automation.status, 'COMPLETE');
      assert.equal(final.accepted.upstream, f.u2);
      assert.equal(final.issues['issue-71'].state, 'closed');
      assert.deepEqual(platform.state.creates, { issues: 1, prs: 2 });
      assert.equal(platform.state.links, 2);
      assert.equal(platform.state.closes, 1);
      assert.equal(
        platform.state.requests.some((path) => path.includes('/related_merge_requests')),
        false,
      );
      assert.equal(await git(f.internal, ['show', 'main:core.txt']), 'second');
      assert.equal((await readFile(receiver.store.path, 'utf8')).includes(platform.token), false);
      assert.deepEqual(platform.state.errors, []);
    },
  );
}
