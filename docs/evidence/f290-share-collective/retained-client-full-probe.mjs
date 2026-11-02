// Run the reviewed Client's real-Service probe against this checkout's retained assets.
// Usage: node docs/evidence/f290-share-collective/retained-client-full-probe.mjs <clean-client-source-root>
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRootArg = process.argv[2];
assert.ok(sourceRootArg && path.isAbsolute(sourceRootArg), 'an absolute Client source root is required');
const sourceRoot = path.resolve(sourceRootArg);
const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const assets = path.join(pluginRoot, 'packages/collective-connector/assets/client');
const source = JSON.parse(await readFile(path.join(assets, 'source.json'), 'utf8'));
const git = (args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
assert.equal(git(['rev-parse', 'HEAD']), source.sourceBaseHead, 'Client source does not match retained asset provenance');
assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'tracked Client source has local changes');

const evidence = path.join(sourceRoot, 'docs/evidence/2026-11-02-f290-share-collective-ui');
let probe = await readFile(path.join(evidence, 'real-service-invitation-probe.mjs'), 'utf8');
const assetLine = "const clientRoot = new URL('../../../packages/collective-client/dist/', import.meta.url);";
const helperImport = "'./host-frame-policy.mjs'";
const clipboardLine = "  const realClipboard = await hostPage.evaluate(() => navigator.clipboard.readText());";
assert.ok(probe.includes(assetLine) && probe.includes(helperImport) && probe.includes(clipboardLine), 'reviewed probe entrypoints changed');
probe = probe
  .replace(assetLine, `const clientRoot = new URL(${JSON.stringify(pathToFileURL(`${assets}${path.sep}`).href)});`)
  .replace(helperImport, JSON.stringify(pathToFileURL(path.join(evidence, 'host-frame-policy.mjs')).href))
  .replace(clipboardLine, `${clipboardLine}\n  assert.ok(realClipboard.includes('退出码不是 0 时先停下'), 'non-zero version checks must stop and report');`);

const directory = await mkdtemp(path.join(tmpdir(), 'f290-retained-client-probe-'));
try {
  const entrypoint = path.join(directory, 'probe.mjs');
  await writeFile(entrypoint, probe);
  const env = { ...process.env, F290_PLUGIN_ROOT: pluginRoot, F290_PLAYWRIGHT_ROOT: pluginRoot };
  delete env.NODE_ENV;
  const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint], {
    cwd: pluginRoot,
    env,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'retained Client probe failed');
  console.log('PASS: seven real-Service scenarios used the retained Client asset directory');
} finally {
  await rm(directory, { recursive: true, force: true });
}
