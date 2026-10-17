import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Frozen canonical inputs; provenance lives in fixtures/retained-sdk/README.md.
// Derive dependency identity from authenticated archives, never from the lock under test.
export async function readRetainedSdkClosure(version = '0.2.0-beta.12.1') {
  const identities = [];
  const rows = version === '0.2.0-beta.12.1' ? [
    ['plugin-sdk', '0.2.0-beta.12.1', 55753, '4766cb318410f01c2d60cb9c1ba11daa3ccbfba583f65f7b013d629eb2da3e94'],
    ['plugin-contract', '0.1.0-beta.29.1', 228040, '1c8de1173eb07b89d3c7737cc6f284dd90650cf8dc4418910b3eedb892d61e96'],
  ] : version === '0.2.0-beta.12' ? [
    ['plugin-sdk', '0.2.0-beta.12', 55750, 'af0cd615aa2b2f8f9de994499f541f83163d9637d56fb89406bc1f7aa023ad7b'],
    ['plugin-contract', '0.1.0-beta.29', 228047, '25225f3c1b3f9935c692dbca7f8f001eca70ab7c198165b4e9ef69ca91d9b458'],
  ] : version === '0.2.0-beta.15' ? [
    ['plugin-sdk', '0.2.0-beta.15', 78680, '60912dfbd6911794b84a303c409215524bfe3629c34c41e1564255aa106cd04f'],
    ['plugin-contract', '0.1.0-beta.30', 229585, '55379eb6d73d690bef91224e6a0684c7ba8938a88c4b63c41e241e3fd3344dd3'],
  ] : version === '0.2.0-beta.19' ? [
    ['plugin-sdk', '0.2.0-beta.19', 89121, 'c2c9cda352dd4cdbe2c2754af57b3baca241ed4a3bc4d2fa0a7454d8a9ac2eef'],
    ['plugin-contract', '0.1.0-beta.35', 236754, 'ca269fb629462d61fce33594de2908aa3c5474d788f9664b0cdb52784002e5f1'],
  ] : undefined;
  assert.ok(rows, `unknown retained SDK version: ${version}`);
  for (const [name, version, size, sha256] of rows) {
    const archive = new URL(`./fixtures/retained-sdk/clowder-ai-${name}-${version}.tgz`, import.meta.url);
    const bytes = await readFile(archive);
    assert.equal(bytes.length, size, `retained ${name} size`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `retained ${name} SHA-256`);
    const result = spawnSync('tar', ['-xOf', fileURLToPath(archive), 'package/package.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.name, `@clowder-ai/${name}`);
    assert.equal(manifest.version, version);
    identities.push({ version, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, manifest });
  }
  const [sdk, contract] = identities;
  assert.equal(sdk.manifest.dependencies['@clowder-ai/plugin-contract'], contract.version);
  return {
    sdk: { version: sdk.version, integrity: sdk.integrity },
    contract: { version: contract.version, integrity: contract.integrity },
  };
}

export async function readRetainedSdkClosures() {
  return Promise.all(['0.2.0-beta.12.1', '0.2.0-beta.15', '0.2.0-beta.19'].map(readRetainedSdkClosure));
}
