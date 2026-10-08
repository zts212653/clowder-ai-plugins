import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBundledPublishGzip } from './canonical-publish-gzip.mjs';
import {
  OFFICIAL_NPM_REGISTRY,
  addImmutableClaim,
  assertRegistryCompatibility,
  collectPublishPackageDirectories,
  readRegistryIntegrity,
} from './registry-publish-compatibility.mjs';

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
