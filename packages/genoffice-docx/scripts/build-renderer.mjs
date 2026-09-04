import { spawnSync } from 'node:child_process';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { assertPackEntries, injectHostPolicy, sha256Sri } from '../dist/artifact-policy.js';
import { assertExtractedSource } from '../dist/source-policy.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(packageRoot, 'source-lock.json'), 'utf8'));
const sourceRoot = join(packageRoot, '.tmp', 'source', lock.rootDirectory);
const docsRoot = join(sourceRoot, 'apps', 'docs');
const viteBinary = join(sourceRoot, 'node_modules', '.bin', 'vite');
const upstreamRenderer = join(sourceRoot, 'apps', 'docs', 'src', 'renderer', 'dist');
const rendererRoot = join(packageRoot, 'renderer');

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

async function walkFiles(root, directory = root) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`renderer symlink is forbidden: ${absolute}`);
    if (metadata.isDirectory()) paths.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) paths.push(relative(root, absolute).replaceAll('\\', '/'));
    else throw new Error(`renderer contains non-regular entry: ${absolute}`);
  }
  return paths;
}

await assertExtractedSource(sourceRoot, lock);
run(
  'npm',
  ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'],
  sourceRoot,
  {
    npm_config_ignore_scripts: 'true',
    npm_config_production: 'false',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    NODE_ENV: 'development',
  },
);
await assertExtractedSource(sourceRoot, lock);

run(
  viteBinary,
  ['build', '--config', 'vite.renderer.config.ts', '--base', './', '--sourcemap'],
  docsRoot,
  {
    npm_config_ignore_scripts: 'true',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    NODE_ENV: 'production',
  },
);

await rm(rendererRoot, { recursive: true, force: true });
await cp(upstreamRenderer, rendererRoot, { recursive: true, errorOnExist: false });
await copyFile(join(packageRoot, 'dist', 'host-bridge.js'), join(rendererRoot, 'host-bridge.js'));
await copyFile(join(packageRoot, 'src', 'host-policy.css'), join(rendererRoot, 'host-policy.css'));

const indexPath = join(rendererRoot, 'index.html');
const hardenedIndex = injectHostPolicy(await readFile(indexPath, 'utf8'), {
  bridgePath: './host-bridge.js',
  policyCssPath: './host-policy.css',
});
if (/\b(?:src|href)="\//u.test(hardenedIndex)) {
  throw new Error('renderer index contains a Host-root asset path');
}
await writeFile(indexPath, hardenedIndex);

if (!hardenedIndex.includes("connect-src 'none'")) throw new Error('renderer CSP is not fail-closed');

const integrity = sha256Sri(await readFile(indexPath));
const manifestPath = join(packageRoot, 'plugin.yaml');
const manifest = parseDocument(await readFile(manifestPath, 'utf8'));
manifest.setIn(['contributions', 0, 'surface', 'integrity'], integrity);
await writeFile(manifestPath, String(manifest));

await copyFile(join(sourceRoot, 'LICENSE'), join(packageRoot, 'LICENSE'));
await copyFile(join(sourceRoot, 'NOTICE'), join(packageRoot, 'NOTICE'));
await mkdir(join(rendererRoot, 'provenance'), { recursive: true });
await writeFile(
  join(rendererRoot, 'provenance', 'source-lock.json'),
  `${JSON.stringify(lock, null, 2)}\n`,
);
run(process.execPath, [join(packageRoot, 'scripts', 'generate-renderer-compliance.mjs')], packageRoot, {
  CARGO_NET_OFFLINE: 'true',
});
const rendererEntries = (await walkFiles(rendererRoot)).map((path) => `package/renderer/${path}`);
assertPackEntries(rendererEntries);

process.stdout.write(
  `${JSON.stringify({ rendererRoot, entrypointIntegrity: integrity, fileCount: rendererEntries.length })}\n`,
);
