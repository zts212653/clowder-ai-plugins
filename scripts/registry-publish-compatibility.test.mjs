import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

import { normalizeBundledPublishGzip } from './canonical-publish-gzip.mjs';
import {
  OFFICIAL_NPM_REGISTRY,
  addImmutableClaim,
  assertRegistryCompatibility,
  collectPublishPackageDirectories,
  collectRetainedPublishArtifacts,
  readRegistryIntegrity,
} from './registry-publish-compatibility.mjs';
import { prepareRetainedPublication } from './prepare-retained-publish-artifact.mjs';
import { readRetainedSdkClosure, readRetainedSdkClosures } from './retained-sdk-fixture.mjs';

const workflowSource = `
jobs:
  validate:
    steps:
      - run: echo validate
  publish:
    steps:
      - uses: ./.github/actions/publish-prerelease
        with:
          package-directory: packages/example
`;

test('publish inventory comes from the workflow publish action inputs', () => {
  assert.deepEqual(collectPublishPackageDirectories(workflowSource), ['packages/example']);
});

test('publisher covers catalog packages and never uploads a held Manager candidate', async () => {
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  const directories = new Set(collectPublishPackageDirectories(source));
  const inventory = JSON.parse(await readFile(new URL('../migration/f202-train-c1-inventory.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
  for (const entry of inventory.repositoryPackages.filter(row => row.managerInstallable && row.releaseAdmission === false)) {
    assert.equal(directories.has(`packages/${entry.directory}`), false, `${entry.directory} has no release admission`);
  }
  for (const plugin of catalog.plugins) {
    assert.ok(directories.has(plugin.versions[0].artifact.provenance.sourceDirectory), `${plugin.pluginId} has no publisher`);
  }
});

test('protected workflow publishes all authenticated retained pairs before current and consuming packages', async () => {
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  const steps = parse(source).jobs.publish.steps;
  const inputs = collectRetainedPublishArtifacts(source);
  const expected = (await readRetainedSdkClosures()).flatMap(pair => ['contract', 'sdk'].map(kind =>
    `scripts/fixtures/retained-sdk/clowder-ai-plugin-${kind}-${pair[kind].version}.tgz`));
  assert.deepEqual(inputs.map(input => input.artifactPath).sort(), expected.sort());
  const currentIndex = steps.findIndex(step => step.uses === './.github/actions/publish-prerelease' &&
    !step.with['retained-artifact']);
  for (const pair of await readRetainedSdkClosures()) {
    const index = kind => steps.findIndex(step => step.with?.['retained-artifact']?.endsWith(
      `clowder-ai-plugin-${kind}-${pair[kind].version}.tgz`));
    assert.ok(index('contract') < index('sdk'));
    assert.ok(index('sdk') < currentIndex, 'current release keeps final next tag ownership');
  }
  assert.ok(collectPublishPackageDirectories(source).includes('packages/github-operations'));
  assert.equal(collectPublishPackageDirectories(source).includes('packages/collective-connector'), false);
  const githubBuild = steps.findIndex(step => step.run === 'pnpm --filter @clowder-ai/github-operations build');
  const githubPublish = steps.findIndex(step => step.with?.['package-directory'] === 'packages/github-operations');
  assert.ok(githubBuild >= 0 && githubBuild < githubPublish);
});

test('retained preparation copies six pinned archives unchanged and rejects path, identity and integrity substitutions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-retained-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  const inputs = collectRetainedPublishArtifacts(source);
  assert.equal(inputs.length, 6);
  for (const input of inputs) {
    const original = await readFile(new URL(`../${input.artifactPath}`, import.meta.url));
    const artifact = await prepareRetainedPublication({ ...input, destination: root });
    assert.deepEqual(await readFile(join(root, artifact.filename)), original);
    assert.equal(artifact.integrity, `sha512-${createHash('sha512').update(original).digest('base64')}`);
    assert.equal(artifact.retained, true);
  }
  const first = inputs[0];
  await assert.rejects(prepareRetainedPublication({ ...first, directory: 'packages/github-operations', destination: root }),
    /authenticated SDK\/contract archive identity/);
  await assert.rejects(prepareRetainedPublication({ ...first, artifactPath: '../outside.tgz', destination: root }),
    /authenticated SDK\/contract archive identity/);
  const alteredRoot = join(root, 'altered');
  const changed = join(alteredRoot, first.artifactPath);
  await mkdir(dirname(changed), { recursive: true });
  await writeFile(changed, 'same filename is not the authenticated archive');
  await assert.rejects(prepareRetainedPublication({ ...first, destination: join(root, 'refused'), root: alteredRoot }),
    /archive integrity mismatch/);
  await assert.rejects(readFile(join(root, 'refused', first.artifactPath.split('/').at(-1))), { code: 'ENOENT' });
});

test('12.1/29.1 release identities preserve every historical implementation and type byte', async t => {
  await readRetainedSdkClosure('0.2.0-beta.12');
  await readRetainedSdkClosure('0.2.0-beta.12.1');
  const root = await mkdtemp(join(tmpdir(), 'clowder-reidentified-prerequisites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, before, after] of [
    ['plugin-contract', '0.1.0-beta.29', '0.1.0-beta.29.1'],
    ['plugin-sdk', '0.2.0-beta.12', '0.2.0-beta.12.1'],
  ]) {
    const directories = [];
    for (const version of [before, after]) {
      const destination = join(root, name, version);
      await mkdir(destination, { recursive: true });
      const archive = new URL(`./fixtures/retained-sdk/clowder-ai-${name}-${version}.tgz`, import.meta.url);
      const extracted = spawnSync('tar', ['-xzf', archive.pathname, '-C', destination], { encoding: 'utf8' });
      assert.equal(extracted.status, 0, extracted.stderr);
      directories.push(join(destination, 'package'));
    }
    const members = await readdir(directories[0], { recursive: true, withFileTypes: true });
    const files = members.filter(member => member.isFile()).map(member =>
      join(member.parentPath, member.name).slice(directories[0].length + 1)).sort();
    const afterMembers = await readdir(directories[1], { recursive: true, withFileTypes: true });
    assert.deepEqual(afterMembers.filter(member => member.isFile()).map(member =>
      join(member.parentPath, member.name).slice(directories[1].length + 1)).sort(), files);
    for (const file of files.filter(file => file !== 'package.json')) {
      assert.deepEqual(await readFile(join(directories[1], file)), await readFile(join(directories[0], file)), file);
    }
    const expected = JSON.parse(await readFile(join(directories[0], 'package.json'), 'utf8'));
    expected.version = after;
    if (name === 'plugin-sdk') expected.dependencies['@clowder-ai/plugin-contract'] = '0.1.0-beta.29.1';
    assert.deepEqual(JSON.parse(await readFile(join(directories[1], 'package.json'), 'utf8')), expected);
  }
});

test('registry gate refuses a conflicting published retained identity before packing current releases', async () => {
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  await assert.rejects(assertRegistryCompatibility({ catalog: { plugins: [] }, workflowSource: source,
    registryIntegrity: async () => 'sha512-conflicting-published-version',
    packCurrentPackage: async () => { assert.fail('retained conflict must stop before current packing'); },
  }), /already published with immutable integrity/u);
});

test('same package version cannot claim two local byte identities', () => {
  const claims = new Map();
  addImmutableClaim(claims, {
    name: '@clowder-ai/example',
    version: '0.1.0-alpha.1',
    integrity: 'sha512-one',
    source: 'catalog',
  });
  assert.throws(
    () => addImmutableClaim(claims, {
      name: '@clowder-ai/example',
      version: '0.1.0-alpha.1',
      integrity: 'sha512-two',
      source: 'publish job',
    }),
    /conflicting local bytes/u,
  );
});

test('registry lookup directly addresses the official npm registry', async () => {
  let requestedUrl;
  const integrity = await readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.1', {
    async fetchFn(url) {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { dist: { integrity: 'sha512-published' } };
        },
      };
    },
  });
  assert.equal(integrity, 'sha512-published');
  assert.equal(requestedUrl.origin, OFFICIAL_NPM_REGISTRY);
  assert.equal(requestedUrl.hostname, 'registry.npmjs.org');
  assert.equal(requestedUrl.pathname, '/%40clowder-ai%2Fexample/0.1.0-alpha.1');
});

test('registry lookup treats only HTTP 404 as an unpublished version', async () => {
  const integrity = await readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.2', {
    fetchFn: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(integrity, undefined);
});

test('registry lookup fails closed on HTTP and network errors', async () => {
  await assert.rejects(
    readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.1', {
      fetchFn: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/u,
  );
  await assert.rejects(
    readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.1', {
      fetchFn: async () => {
        throw new Error('network unavailable');
      },
    }),
    /npm registry lookup failed/u,
  );
});

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
  test(`registry retries ${code} with bounded backoff then reads authoritative metadata`, async () => {
    let calls = 0;
    const delays = [];
    const result = await readRegistryIntegrity('@clowder-ai/example', '1.0.0', {
      sleep: async ms => { delays.push(ms); },
      fetchFn: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('transient'), { code }) });
        return { ok: true, status: 200, json: async () => ({ dist: { integrity: 'sha512-real' } }) };
      },
    });
    assert.equal(result, 'sha512-real');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
  });
}

test('registry exhausts transient retries without treating failure as unpublished', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
    sleep: async ms => { delays.push(ms); },
    fetchFn: async () => { calls += 1; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); },
  }), /npm registry lookup failed/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} fails immediately, even after a transient network failure`, async () => {
    let calls = 0;
    await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
      sleep: async () => {},
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return { ok: false, status };
      },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 2);
  });
}

test('registry body transport failures retry, malformed metadata does not', async () => {
  let calls = 0;
  await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
    sleep: async () => {},
    fetchFn: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => {
        if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return {};
      } };
    },
  }), /no dist.integrity/);
  assert.equal(calls, 2);
});

test('registry deadlines abort stuck transport attempts and exhaust a finite budget', async () => {
  let calls = 0;
  await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
    timeoutMs: 5,
    sleep: async () => {},
    fetchFn: async (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  }), /npm registry lookup failed/);
  assert.equal(calls, 3);
});

test('bundled publish gzip identity is stable across macOS and Ubuntu', () => {
  const macos = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 19, 1, 2, 3]);
  const ubuntu = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
  assert.deepEqual(normalizeBundledPublishGzip(macos), ubuntu);
  assert.deepEqual(normalizeBundledPublishGzip(ubuntu), ubuntu);
});

test('bundled publish gzip refuses to invalidate an FHCRC header', () => {
  const withHeaderCrc = Buffer.from([0x1f, 0x8b, 0x08, 0x02, 0, 0, 0, 0, 0, 19, 1, 2, 3]);
  assert.throws(
    () => normalizeBundledPublishGzip(withHeaderCrc),
    /gzip has FHCRC; refusing to rewrite header/u,
  );
});

test('published catalog and publish-job bytes must match the immutable registry bytes', async () => {
  const catalog = {
    plugins: [{
      pluginId: 'example',
      versions: [{
        version: '0.1.0-alpha.1',
        artifact: {
          kind: 'npm',
          packageName: '@clowder-ai/example',
          version: '0.1.0-alpha.1',
          integrity: 'sha512-local',
        },
      }],
    }],
  };
  await assert.rejects(
    assertRegistryCompatibility({
      catalog,
      workflowSource,
      registryIntegrity: async () => 'sha512-published',
      packCurrentPackage: async () => ({
        name: '@clowder-ai/example',
        version: '0.1.0-alpha.1',
        integrity: 'sha512-local',
      }),
    }),
    /already published with immutable integrity sha512-published/u,
  );
});

test('unpublished current versions and matching published history pass together', async () => {
  const catalog = {
    plugins: [{
      pluginId: 'example',
      versions: [{
        version: '0.1.0-alpha.1',
        artifact: {
          kind: 'npm',
          packageName: '@clowder-ai/example',
          version: '0.1.0-alpha.1',
          integrity: 'sha512-published',
        },
      }],
    }],
  };
  const result = await assertRegistryCompatibility({
    catalog,
    workflowSource,
    registryIntegrity: async (_name, version) => (
      version === '0.1.0-alpha.1' ? 'sha512-published' : undefined
    ),
    packCurrentPackage: async () => ({
      name: '@clowder-ai/example',
      version: '0.1.0-alpha.2',
      integrity: 'sha512-next',
    }),
  });
  assert.deepEqual(result.published, ['@clowder-ai/example@0.1.0-alpha.1']);
  assert.deepEqual(result.unpublished, ['@clowder-ai/example@0.1.0-alpha.2']);
});


async function runPublicationAction(t, { retained, published, tags, integrity = 'sha512-exact', registryIntegrity = integrity, restoreRaceNext, packageExists = true }) {
  const root = await mkdtemp(join(tmpdir(), 'clowder-publication-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const statePath = join(root, 'registry.json');
  const state = { published, tags, integrity: registryIntegrity, restoreRaceNext, packageExists, mutations: [] };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.MOCK_REGISTRY, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'view') {
  if (args[2] === 'dist-tags') {
    if (!state.packageExists) { console.error('E404'); process.exit(1); }
    if (state.mutations.length && process.env.DIST_TAGS_JSON_PATH?.endsWith('prerelease-restore-tags.json') && state.restoreRaceNext) {
      state.tags.next = state.restoreRaceNext;
      fs.writeFileSync(process.env.MOCK_REGISTRY, JSON.stringify(state));
    }
    console.log(JSON.stringify(state.tags));
  }
  else if (state.published) console.log(JSON.stringify({version:process.env.PACKAGE_VERSION,dist:{integrity:state.integrity}}));
  else { console.error('E404'); process.exit(1); }
} else if (args[0] === 'publish') {
  state.published = true;
  state.packageExists = true;
  state.tags.next = process.env.PACKAGE_VERSION;
  state.tags.latest ??= process.env.PACKAGE_VERSION;
  state.mutations.push(args);
  fs.writeFileSync(process.env.MOCK_REGISTRY, JSON.stringify(state));
} else if (args[0] === 'dist-tag' && args[1] === 'add') {
  if (args[3] !== 'next') throw new Error('only next is authorized in this regression');
  state.tags.next = args[2].slice(args[2].lastIndexOf('@') + 1);
  state.mutations.push(args);
  fs.writeFileSync(process.env.MOCK_REGISTRY, JSON.stringify(state));
} else { throw new Error('unexpected npm call: '+JSON.stringify(args)); }
`);
  // One failed inspection is enough to reproduce a tag mismatch without a five-minute wait.
  await writeFile(join(bin, 'seq'), '#!/bin/sh\necho 1\n');
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  for (const name of ['npm', 'seq', 'sleep']) await chmod(join(bin, name), 0o755);
  const action = parse(await readFile(new URL('../.github/actions/publish-prerelease/action.yml', import.meta.url), 'utf8'));
  const outputs = { pack: { name: '@clowder-ai/plugin-sdk', version: '0.1.0-beta.12', integrity, filename: 'exact.tgz' }, registry: {} };
  const inputs = { 'retained-artifact': retained ? 'authenticated-retained.tgz' : '', 'npm-token': '' };
  const interpolate = value => value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, key) => {
    if (key === 'runner.temp') return root;
    if (key.startsWith('inputs.')) return inputs[key.slice(7)];
    const [, id, field] = /^steps\.([^.]+)\.outputs\.([^.]+)$/.exec(key);
    return outputs[id][field] ?? '';
  });
  let failure;
  for (const step of action.runs.steps.slice(1)) {
    if (step.if && published) continue;
    if (step.if?.includes('retained-artifact') && !retained) continue;
    const outputPath = join(root, 'output');
    await writeFile(outputPath, '');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_REGISTRY: statePath,
      PACKAGE_VERSION: outputs.pack.version, GITHUB_OUTPUT: outputPath,
      ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, interpolate(value)])) };
    for (const key of Object.keys(env)) if (key.toUpperCase().includes('TOKEN')) delete env[key];
    const result = spawnSync('bash', ['-c', step.run], { env, cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    if (result.status !== 0) { failure = { step: step.name, status: result.status, stderr: result.stderr }; break; }
    if (step.id) for (const line of (await readFile(outputPath, 'utf8')).trim().split('\n')) {
      const split = line.indexOf('=');
      outputs[step.id][line.slice(0, split)] = line.slice(split + 1);
    }
  }
  return { failure, state: JSON.parse(await readFile(statePath, 'utf8')) };
}

test('retained publication replay validates immutable bytes without demanding an older next tag', async t => {
  const result = await runPublicationAction(t, { retained: true, published: true,
    tags: { latest: '1.0.0', next: '0.1.0-beta.20' } });
  assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  assert.deepEqual(result.state.tags, { latest: '1.0.0', next: '0.1.0-beta.20' });
  assert.deepEqual(result.state.mutations, []);
});

test('new retained prerequisite restores an existing next tag after its exact upload', async t => {
  const result = await runPublicationAction(t, { retained: true, published: false,
    tags: { latest: '1.0.0', next: '0.1.0-beta.20' } });
  assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  assert.deepEqual(result.state.tags, { latest: '1.0.0', next: '0.1.0-beta.20' });
});


for (const published of [false, true]) {
  test(`retained ${published ? 'replay' : 'first upload'} preserves the existing no-next behavior`, async t => {
    const result = await runPublicationAction(t, { retained: true, published, tags: {} });
    assert.equal(result.failure, undefined, JSON.stringify(result.failure));
    assert.deepEqual(result.state.tags, published ? {} : { latest: '0.1.0-beta.12', next: '0.1.0-beta.12' });
    assert.equal(result.state.mutations.length, published ? 0 : 1);
  });
}

test('ordinary current publisher still owns next and preserves stable latest', async t => {
  const result = await runPublicationAction(t, { retained: false, published: false,
    tags: { latest: '1.0.0', next: '0.1.0-beta.11' } });
  assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  assert.deepEqual(result.state.tags, { latest: '1.0.0', next: '0.1.0-beta.12' });
  assert.equal(result.state.mutations.length, 1);
});

test('retained replay refuses a conflicting immutable registry integrity before mutation', async t => {
  const result = await runPublicationAction(t, { retained: true, published: true,
    tags: { latest: '1.0.0', next: '0.1.0-beta.20' }, registryIntegrity: 'sha512-conflict' });
  assert.equal(result.failure?.step, 'Inspect registry before publish');
  assert.match(result.failure.stderr, /registry integrity mismatch/);
  assert.deepEqual(result.state.mutations, []);
});

test('retained tag restore refuses an observed competing release instead of overwriting it', async t => {
  const result = await runPublicationAction(t, { retained: true, published: false,
    tags: { latest: '1.0.0', next: '0.1.0-beta.20' }, restoreRaceNext: '0.1.0-beta.21' });
  assert.equal(result.failure?.step, 'Preserve existing next after retained upload');
  assert.match(result.failure.stderr, /next changed outside/);
  assert.equal(result.state.tags.next, '0.1.0-beta.21');
  assert.equal(result.state.mutations.length, 1, 'no dist-tag write after detecting competition');
});

test('retained preflight rejects a malformed next snapshot before upload or tag mutation', async t => {
  const result = await runPublicationAction(t, { retained: true, published: false,
    tags: { latest: '1.0.0', next: '0.1.0-beta.20\nprevious_next=attacker' } });
  assert.equal(result.failure?.step, 'Inspect registry before publish');
  assert.match(result.failure.stderr, /invalid registry next tag/);
  assert.deepEqual(result.state.mutations, []);
});


test('retained first package publication handles official package E404 without inventing previous tags', async t => {
  const result = await runPublicationAction(t, { retained: true, published: false, packageExists: false, tags: {} });
  assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  assert.deepEqual(result.state.tags, { latest: '0.1.0-beta.12', next: '0.1.0-beta.12' });
  assert.equal(result.state.mutations.length, 1);
});

test('ordinary current replay keeps its next check instead of adopting retained tag relaxation', async t => {
  const result = await runPublicationAction(t, { retained: false, published: true,
    tags: { latest: '1.0.0', next: '0.1.0-beta.20' } });
  assert.equal(result.failure?.step, 'Inspect published registry state');
  assert.match(result.failure.stderr, /registry next tag mismatch/);
  assert.deepEqual(result.state.mutations, []);
});
