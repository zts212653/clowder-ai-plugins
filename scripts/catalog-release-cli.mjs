import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCatalogAvailable, assertInitialPluginSelectionAvailable, assertPublishedArchive,
  readPublishedArchive } from './catalog-activation.mjs';
import { assertReleasePlans, releaseReport, releaseStatus } from './catalog-release.mjs';
import { readRegistryIntegrity } from './registry-publish-compatibility.mjs';
import { syncReleaseIssues } from './catalog-release-issues.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const emptyPlans = { schemaVersion: 1, releases: [] };

function baseFile(root, sha, path, { optional = false } = {}) {
  const exists = spawnSync('git', ['cat-file', '-e', `${sha}:${path}`], { cwd: root, encoding: 'utf8' });
  if (exists.status !== 0 && optional) return emptyPlans;
  const result = spawnSync('git', ['show', `${sha}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `Cannot read PR base ${path}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function runReleaseCommand(args, {
  root = repoRoot, now = Date.now(), registryIntegrity = readRegistryIntegrity,
  readArchive = readPublishedArchive, notify = syncReleaseIssues,
  repository = process.env.GITHUB_REPOSITORY,
} = {}) {
  const [mode, ...options] = args;
  assert.ok(['--check-plan', '--audit'].includes(mode), 'Use --check-plan [--base-sha <sha>] or --audit [--notify]');
  const candidate = JSON.parse(await readFile(join(root, 'catalog/candidate.json'), 'utf8'));
  const live = JSON.parse(await readFile(join(root, 'catalog/catalog.json'), 'utf8'));
  const plans = JSON.parse(await readFile(join(root, 'catalog/release-plans.json'), 'utf8'));
  if (mode === '--check-plan') {
    assert.ok(options.length === 0 || (options.length === 2 && options[0] === '--base-sha'), 'Use --base-sha <commit>');
    const sha = options[1];
    if (sha !== undefined) assert.match(sha, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u, 'PR base must be an exact commit SHA');
    const count = assertReleasePlans(candidate, live, plans, { now,
      ...(sha === undefined ? {} : { baseCandidate: baseFile(root, sha, 'catalog/candidate.json'),
        basePlans: baseFile(root, sha, 'catalog/release-plans.json', { optional: true }) }),
    });
    return { message: `Release destinations checked before merge: ${count} selected plugin releases.` };
  }
  assert.ok(options.length === 0 || (options.length === 1 && options[0] === '--notify'), 'Use --audit [--notify]');
  assertInitialPluginSelectionAvailable(JSON.parse(await readFile(join(root, 'catalog/initial-plugins.json'), 'utf8')), live);
  await assertCatalogAvailable(live, { registryIntegrity, readArchive });
  const rows = releaseStatus(candidate, live, plans, { now });
  for (const row of rows) {
    if (row.state === 'active') { row.published = true; continue; }
    const { artifact } = row;
    const integrity = await registryIntegrity(artifact.packageName, row.version);
    row.published = integrity !== undefined;
    if (row.published) {
      assert.equal(integrity, artifact.integrity, `${row.pluginId}@${row.version}: immutable registry identity mismatch`);
      assertPublishedArchive(await readArchive(artifact.tarballUrl), artifact);
    }
  }
  const reminders = options.includes('--notify') ? await notify(rows, { repository }) : [];
  return { rows, reminders, message: releaseReport(rows) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runReleaseCommand(process.argv.slice(2));
  console.log(result.message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result.message}\n`);
  if (process.env.CATALOG_RELEASE_REPORT) await writeFile(process.env.CATALOG_RELEASE_REPORT, `${JSON.stringify(result, null, 2)}\n`);
}
