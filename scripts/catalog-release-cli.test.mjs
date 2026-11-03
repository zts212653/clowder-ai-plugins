import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { activateCatalog } from './catalog-activation.mjs';
import { runReleaseCommand } from './catalog-release-cli.mjs';
import { syncReleaseIssues } from './catalog-release-issues.mjs';

const now = Date.parse('2026-11-03T02:00:00Z');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'catalog-release-journey-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'catalog')); await mkdir(join(root, 'package'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Sol release fixture');
  git('config', 'user.email', 'sol-release-fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const archives = new Map(), published = new Map();
  const issues = [], writes = [];
  function runGh(args, body) {
    if (args.includes('--paginate')) return issues.map(issue => JSON.stringify(issue)).join('\n');
    writes.push({ args, body });
    if (args.some(arg => arg.endsWith('/comments'))) return JSON.stringify({ id: writes.length, ...body });
    if (args.includes('POST')) {
      const issue = { number: issues.length + 1, state: 'open', ...body }; issues.push(issue);
      return JSON.stringify(issue);
    }
    const issue = issues.find(issue => args.includes(`repos/example/plugins/issues/${issue.number}`));
    assert.ok(issue, 'must update the exact existing reminder'); Object.assign(issue, body);
    return JSON.stringify(issue);
  }
  async function release(pluginId, version) {
    const packageName = `@clowder-ai/${pluginId.split('.').at(-1)}`;
    await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: packageName, version }));
    const tar = spawnSync('tar', ['-czf', '-', '-C', root, 'package']); assert.equal(tar.status, 0);
    const artifact = { kind: 'npm', packageName, version,
      tarballUrl: `https://registry.npmjs.org/${packageName}/-/${packageName.split('/').at(-1)}-${version}.tgz`,
      integrity: `sha512-${createHash('sha512').update(tar.stdout).digest('base64')}`,
      shasum: createHash('sha1').update(tar.stdout).digest('hex'),
      provenance: { repository: 'https://github.com/example/plugins', sourceDirectory: 'packages/example' } };
    archives.set(artifact.tarballUrl, tar.stdout);
    return { version, contractVersion: '0.1.0', manifestPath: 'plugin.yaml', artifact };
  }
  const entry = (pluginId, versions) => ({ pluginId, name: pluginId, description: pluginId,
    icon: { type: 'svg', src: 'assets/icon.svg' }, publisher: { id: 'example', name: 'Example' }, versions });
  const previous = await release('official.example', '0.1.0-alpha.1');
  const live = { schemaVersion: '1', plugins: [entry('official.example', [previous])] };
  const candidate = structuredClone(live), plans = { schemaVersion: 1, releases: [] };
  const publish = row => published.set(`${row.artifact.packageName}@${row.version}`, row.artifact.integrity);
  publish(previous);
  const save = async () => {
    for (const [name, value] of Object.entries({ candidate, catalog: live, 'release-plans': plans,
      'initial-plugins': { schemaVersion: 1, plugins: [{ pluginId: 'official.example', enabled: true }] } })) {
      await writeFile(join(root, `catalog/${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  const commit = message => { git('add', 'catalog'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  const plan = (pluginId, row, disposition = 'activate') => ({ pluginId, version: row.version,
    integrity: row.artifact.integrity, owner: disposition === 'defer' ? 'opus55' : 'codex61-sol', disposition,
    reviewBy: '2026-11-05T08:00:00Z', sourceRef: 'https://github.com/example/plugins/pull/1',
    ...(disposition === 'defer' ? { reason: 'Wait for paired Host.', condition: 'Combined acceptance passes.' } : {}) });
  await save(); const base = commit('Baseline live release');
  const options = { root, now, repository: 'example/plugins',
    registryIntegrity: async (name, version) => published.get(`${name}@${version}`),
    readArchive: async url => { assert.ok(archives.has(url)); return archives.get(url); },
    notify: (rows, { repository }) => syncReleaseIssues(rows, { repository, runGh }) };
  return { root, git, archives, published, issues, writes, previous, live, candidate, plans, base,
    options, save, commit, plan, release, publish, entry };
}

test('source PR → merge → npm publication → scoped catalog PR stays green, while an undeclared PR is blocked', async t => {
  const f = await fixture(t);
  f.git('checkout', '-b', 'source-pr');
  const next = await f.release('official.example', '0.1.0-alpha.2');
  f.candidate.plugins[0].versions.unshift(next); await f.save();
  await assert.rejects(runReleaseCommand(['--check-plan', '--base-sha', f.base], f.options), /declare an exact release plan/);
  f.plans.releases.push(f.plan('official.example', next)); await f.save();
  await runReleaseCommand(['--check-plan', '--base-sha', f.base], f.options);
  f.commit('Declare release and its activation owner');
  f.git('checkout', 'main'); f.git('merge', '--ff-only', 'source-pr');
  f.publish(next);
  const published = await runReleaseCommand(['--audit', '--notify'], f.options);
  assert.equal(published.rows[0].state, 'activation-pending');
  assert.equal(published.rows[0].published, true);
  assert.equal(f.issues.length, 1); assert.match(f.issues[0].body, /codex61-sol/);
  const writeCount = f.writes.length;
  await runReleaseCommand(['--audit', '--notify'], f.options);
  assert.equal(f.writes.length, writeCount, 'unchanged daily audit does not spam or duplicate issues');

  // Another legitimate release waits while this release's catalog PR proceeds.
  const waitingPrevious = await f.release('official.waiting', '0.1.0-alpha.1');
  const waiting = await f.release('official.waiting', '0.1.0-alpha.2');
  f.live.plugins.push(f.entry('official.waiting', [waitingPrevious]));
  f.candidate.plugins.push(f.entry('official.waiting', [waiting, waitingPrevious]));
  f.plans.releases.push(f.plan('official.waiting', waiting, 'defer'));
  f.publish(waitingPrevious); f.publish(waiting); await f.save();
  await runReleaseCommand(['--check-plan', '--base-sha', f.git('rev-parse', 'HEAD')], f.options);
  f.commit('Record the paired Host wait');
  const beforeActivation = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-b', 'catalog-pr');
  await activateCatalog({ ...f.options, pluginIds: ['official.example'] });
  await runReleaseCommand(['--check-plan', '--base-sha', beforeActivation], f.options);
  f.commit('Activate one published plugin');
  f.git('checkout', 'main'); f.git('merge', '--ff-only', 'catalog-pr');
  const active = await runReleaseCommand(['--audit', '--notify'], f.options);
  assert.deepEqual(active.rows.map(row => row.state), ['active', 'deferred']);
  assert.equal(f.issues[0].state, 'closed');
  assert.equal(f.issues.length, 1, 'a future owner-backed wait is visible without a premature reminder');

  const overdue = await runReleaseCommand(['--audit', '--notify'], { ...f.options, now: Date.parse('2026-11-06T00:00:00Z') });
  assert.equal(overdue.rows[1].state, 'overdue');
  assert.equal(f.issues.length, 2); assert.match(f.issues[1].body, /opus55/);
  assert.match(f.issues[1].body, /Combined acceptance passes/);
});

test('manual publication without a plan creates an unowned reminder without failing the audit', async t => {
  const f = await fixture(t), next = await f.release('official.example', '0.1.0-alpha.2');
  f.candidate.plugins[0].versions.unshift(next); f.publish(next); await f.save();
  const result = await runReleaseCommand(['--audit', '--notify'], f.options);
  assert.equal(result.rows[0].state, 'unowned'); assert.equal(f.issues.length, 1);
  assert.match(f.issues[0].body, /assign an owner/);
});

test('audit still refuses corrupt published identity and does not swallow notification failures', async t => {
  const f = await fixture(t), next = await f.release('official.example', '0.1.0-alpha.2');
  f.candidate.plugins[0].versions.unshift(next); f.plans.releases.push(f.plan('official.example', next));
  f.publish(next); await f.save();
  f.published.set(`${next.artifact.packageName}@${next.version}`, 'wrong digest');
  await assert.rejects(runReleaseCommand(['--audit'], f.options), /immutable registry identity mismatch/);
  f.publish(next);
  await assert.rejects(runReleaseCommand(['--audit', '--notify'], { ...f.options,
    notify: () => { throw new Error('GitHub delivery unavailable'); } }), /GitHub delivery unavailable/);
});

test('PR base uses exact Git objects and rejects shell/option injection', async t => {
  const f = await fixture(t);
  await assert.rejects(runReleaseCommand(['--check-plan', '--base-sha', '--output=bad'], f.options), /exact commit SHA/);
  await assert.rejects(runReleaseCommand(['--check-plan', '--base-sha', '1'.repeat(40)], f.options), /Cannot read PR base/);
});

test('workflow checks release destinations on PRs and reports waiting after publication and in the daily audit', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8'));
  const preflight = ci.jobs.validate.steps.find(step => step.name === 'Validate release destinations before merge');
  assert.ok(preflight, 'the required PR check must exercise release intent');
  assert.equal(preflight.if, "github.event_name == 'pull_request'");
  assert.match(preflight.run, /catalog:release-check.*--base-sha/);
  assert.equal(preflight.env.RELEASE_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(ci.jobs.publish.steps.at(-1).run, 'pnpm catalog:release-audit');
  const daily = parse(await readFile(new URL('../.github/workflows/catalog-activation.yml', import.meta.url), 'utf8'));
  assert.equal(daily.permissions.issues, 'write');
  assert.equal(daily.jobs.activation.steps.at(-1).run, 'pnpm catalog:release-audit -- --notify');
  assert.equal(daily.concurrency['cancel-in-progress'], false, 'serialize reminder writers rather than race duplicate issues');
});
