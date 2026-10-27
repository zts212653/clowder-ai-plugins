import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const cli = dirname(dirname(require.resolve('@larksuite/cli/scripts/run.js')));
const metadata = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8'));
assert.equal(metadata.version, '1.0.85');

// Publication bytes must not depend on the build host. These are the two
// platforms exercised by the protected Linux publisher and the Phase D Host.
const targets = [
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64', assetArch: 'arm64' },
  { key: 'linux-x64', platform: 'linux', arch: 'x64', assetArch: 'amd64' },
];
const checksumLines = (await readFile(join(cli, 'checksums.txt'), 'utf8')).split('\n');
const cache = join(root, '.clowder-local-directory', 'runner-cache');
const output = join(root, 'dist', 'lark-cli-runners');
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });

const runners = {};
for (const target of targets) {
  const asset = `lark-cli-${metadata.version}-${target.platform}-${target.assetArch}.tar.gz`;
  const archiveSha256 = checksumLines.find((line) => line.endsWith(`  ${asset}`))?.split(' ')[0];
  assert.match(archiveSha256 ?? '', /^[a-f0-9]{64}$/);
  const source = `https://github.com/larksuite/cli/releases/download/v${metadata.version}/${asset}`;
  const cached = join(cache, asset);
  let bytes;
  try {
    bytes = await readFile(cached);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `Pinned Lark runner download failed: ${asset}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= 64 * 1024 * 1024, 'Runner archive exceeds its bound');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), archiveSha256);
    try {
      await writeFile(cached, bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      bytes = await readFile(cached);
    }
  }
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    archiveSha256,
    `Cached runner archive checksum mismatch: ${asset}`,
  );
  const listing = execFileSync('tar', ['-tvzf', cached], { encoding: 'utf8' });
  assert.ok(
    listing.split('\n').some((line) => line.startsWith('-') && line.endsWith(' lark-cli')),
    `${asset} must contain a regular lark-cli`,
  );
  const binary = execFileSync('tar', ['-xOzf', cached, 'lark-cli'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(binary.length > 0 && binary.length <= 64 * 1024 * 1024);
  await copyFile(cached, join(output, asset));
  runners[target.key] = {
    platform: target.platform,
    arch: target.arch,
    asset,
    source,
    archiveSha256,
    binarySha256: createHash('sha256').update(binary).digest('hex'),
    binaryBytes: binary.length,
  };
}

await writeFile(
  join(root, 'dist', 'lark-cli-runners.json'),
  `${JSON.stringify({ version: metadata.version, runners }, null, 2)}\n`,
);
console.log(JSON.stringify({ version: metadata.version, runners }));
