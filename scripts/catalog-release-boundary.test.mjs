import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { syncReleaseIssues } from './catalog-release-issues.mjs';
import { releaseStatus } from './catalog-release.mjs';

const now = Date.parse('2026-11-03T02:00:00Z');

test('real pnpm argv reaches the production command and real gh spawning sends JSON for create/update/close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-release-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'catalog')); await mkdir(join(root, 'package')); await mkdir(join(root, 'bin'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Sol release fixture');
  git('config', 'user.email', 'sol-release-fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  async function release(version) {
    await writeFile(join(root, 'package/package.json'), JSON.stringify({ name: '@clowder-ai/example', version }));
    const tar = spawnSync('tar', ['-czf', '-', '-C', root, 'package']); assert.equal(tar.status, 0);
    await writeFile(join(root, `${version}.tgz`), tar.stdout);
    return { version, contractVersion: '0.1.0', manifestPath: 'plugin.yaml', artifact: {
      kind: 'npm', packageName: '@clowder-ai/example', version,
      tarballUrl: `https://registry.npmjs.org/@clowder-ai/example/-/example-${version}.tgz`,
      integrity: `sha512-${createHash('sha512').update(tar.stdout).digest('base64')}`,
      shasum: createHash('sha1').update(tar.stdout).digest('hex'),
      provenance: { repository: 'https://github.com/example/plugins', sourceDirectory: 'packages/example' },
    } };
  }
  const old = await release('0.1.0-alpha.1'), next = await release('0.1.0-alpha.2');
  const live = { schemaVersion: '1', plugins: [{ pluginId: 'official.example', name: 'Example', description: 'Example',
    icon: { type: 'svg', src: 'assets/icon.svg' }, publisher: { id: 'example', name: 'Example' }, versions: [old] }] };
  let candidate = structuredClone(live);
  const plans = { schemaVersion: 1, releases: [] };
  const save = async () => {
    for (const [name, value] of Object.entries({ candidate, catalog: live, 'release-plans': plans,
      'initial-plugins': { schemaVersion: 1, plugins: [{ pluginId: 'official.example', enabled: true }] } })) {
      await writeFile(join(root, `catalog/${name}.json`), JSON.stringify(value));
    }
  };
  await save(); git('add', 'catalog'); git('commit', '-m', 'Baseline'); const base = git('rev-parse', 'HEAD');
  candidate.plugins[0].versions.unshift(next);
  plans.releases.push({ pluginId: 'official.example', version: next.version, integrity: next.artifact.integrity,
    owner: 'codex61-sol', disposition: 'activate', reviewBy: '2026-11-05T08:00:00Z',
    sourceRef: 'https://github.com/example/plugins/pull/1' });
  await save();

  // Only fixture data and npm I/O are supplied here. Production parsing,
  // validation, audit, issue reconciliation and gh spawning execute unchanged.
  await writeFile(join(root, 'run-release.mjs'), `
import { readFile } from 'node:fs/promises';
import { runReleaseCommand } from ${JSON.stringify(new URL('./catalog-release-cli.mjs', import.meta.url).href)};
const root = ${JSON.stringify(root)};
const candidate = JSON.parse(await readFile(root + '/catalog/candidate.json', 'utf8'));
console.log('ARGV:' + JSON.stringify(process.argv.slice(2)));
const result = await runReleaseCommand(process.argv.slice(2), { root, now: ${now}, repository: 'example/plugins',
  registryIntegrity: async (_, version) => candidate.plugins[0].versions.find(row => row.version === version)?.artifact.integrity,
  readArchive: async url => readFile(root + '/' + url.match(/example-(.+)\.tgz$/)[1] + '.tgz'),
});
console.log(result.message);
`);
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true,
    scripts: { 'catalog:release-check': 'node run-release.mjs --check-plan', 'catalog:release-audit': 'node run-release.mjs --audit' } }));
  const statePath = join(root, 'gh-state.json'), logPath = join(root, 'gh-calls.jsonl');
  await writeFile(statePath, '[]');
  await writeFile(join(root, 'bin/gh'), `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2), input = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, input }) + '\\n');
const statePath = ${JSON.stringify(statePath)}, issues = JSON.parse(readFileSync(statePath));
if (args.includes('--paginate')) { console.log(issues.map(issue => JSON.stringify(issue)).join('\\n')); process.exit(0); }
const payload = JSON.parse(input);
let issue;
if (args.includes('POST')) { issue = { number: issues.length + 1, state: 'open', ...payload }; issues.push(issue); }
else { issue = issues.find(row => args.includes('repos/example/plugins/issues/' + row.number)); if (!issue) process.exit(2); Object.assign(issue, payload); }
writeFileSync(statePath, JSON.stringify(issues)); console.log(JSON.stringify(issue));
`, { mode: 0o755 });
  // The fake executable replaces only GitHub at the process boundary.
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}${delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const pnpm = (...args) => spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const checked = pnpm('catalog:release-check', '--', '--base-sha', base);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /ARGV:\["--check-plan","--","--base-sha"/);
  const audited = pnpm('catalog:release-audit', '--', '--notify');
  assert.equal(audited.status, 0, audited.stdout + audited.stderr);
  assert.match(audited.stdout, /ARGV:\["--audit","--","--notify"\]/);
  const rows = releaseStatus(candidate, live, plans, { now }); rows[0].published = true;
  rows[0].state = 'overdue'; syncReleaseIssues(rows, { repository: 'example/plugins' });
  let stored = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stored.length, 2, 'overdue must create a fresh opened event, not merely a comment');
  assert.deepEqual(stored.map(issue => issue.state), ['closed', 'open']);
  assert.match(stored[1].body, /overdue/);
  const beforeRepeat = (await readFile(logPath, 'utf8')).trim().split('\n').length;
  syncReleaseIssues(rows, { repository: 'example/plugins' });
  assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, beforeRepeat + 1,
    'the same alert only reads existing issues, without another write');
  rows[0].plan.owner = 'sonnet'; syncReleaseIssues(rows, { repository: 'example/plugins' });
  stored = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stored.length, 3, 'a new owner also needs a fresh opened event');
  assert.deepEqual(stored.map(issue => issue.state), ['closed', 'closed', 'open']);
  rows[0].plan.reason = 'Updated dependency details'; syncReleaseIssues(rows, { repository: 'example/plugins' });
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).length, 3, 'same alert metadata is updated in place');

  // A reviewed deadline extension can later expire again. The old, closed
  // overdue issue must not be reused, because that would lose the new opening.
  plans.releases[0].reviewBy = '2026-11-07T08:00:00Z';
  const renewed = releaseStatus(candidate, live, plans, { now: Date.parse('2026-11-08T00:00:00Z') });
  renewed[0].published = true; syncReleaseIssues(renewed, { repository: 'example/plugins' });
  stored = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stored.length, 4, 'a later review deadline gets its own overdue opening');
  assert.deepEqual(stored.map(issue => issue.state), ['closed', 'closed', 'closed', 'open']);
  renewed[0].state = 'active'; syncReleaseIssues(renewed, { repository: 'example/plugins' });
  const writes = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(call => call.args.includes('--method'));
  assert.equal(writes.filter(call => call.args.includes('POST')).length, 4);
  assert.equal(writes.filter(call => call.args.includes('PATCH')).length, 5);
  for (const call of writes) assert.deepEqual(call.args.slice(-2), ['--input', '-']);
  assert.ok(writes.every(call => !call.args.some(arg => arg.endsWith('/comments'))));
  assert.match(JSON.parse(writes[0].input).body, /codex61-sol/);
  assert.match(JSON.parse(writes[3].input).body, /sonnet/);
  assert.deepEqual(JSON.parse(writes.at(-1).input), { state: 'closed' });
  assert.ok(JSON.parse(await readFile(statePath, 'utf8')).every(issue => issue.state === 'closed'));

  plans.releases = []; await save();
  const unowned = pnpm('catalog:release-check', '--', '--base-sha', base);
  assert.notEqual(unowned.status, 0);
  assert.match(unowned.stdout + unowned.stderr, /declare an exact release plan/);
});
