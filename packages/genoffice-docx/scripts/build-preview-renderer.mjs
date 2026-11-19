/**
 * Build the read-only preview renderer and publish it into the plugin package.
 *
 * The GenOffice source tree is large; building inside the package directory is
 * not viable on a small drive. GENOFFICE_SOURCE_ROOT lets the caller point at a
 * pre-extracted, dependency-installed tree.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { assertPackEntries, injectPreviewPolicy, sha256Sri } from '../dist/artifact-policy.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(packageRoot, 'source-lock.json'), 'utf8'));
const sourceRoot =
  process.env.GENOFFICE_SOURCE_ROOT ?? join(packageRoot, '.tmp', 'source', lock.rootDirectory);
const appName = 'genoffice-preview-237';
const appRoot = join(sourceRoot, 'apps', appName);
const rendererRoot = join(packageRoot, 'renderer', 'preview');
const contributionId = 'genoffice-preview';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
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

const sourcePackage = join(sourceRoot, 'package.json');
if (!(await readFile(sourcePackage, 'utf8').catch(() => null))) {
  throw new Error(
    `GenOffice source tree missing at ${sourceRoot}; set GENOFFICE_SOURCE_ROOT to a prepared tree`,
  );
}

await rm(appRoot, { recursive: true, force: true });
await cp(join(packageRoot, 'preview'), join(appRoot, 'preview'), { recursive: true });
// Mirror the package layout so `../src/preview-protocol` resolves inside the build tree.
await mkdir(join(appRoot, 'src'), { recursive: true });
await copyFile(
  join(packageRoot, 'src', 'preview-protocol.ts'),
  join(appRoot, 'src', 'preview-protocol.ts'),
);

run(process.execPath, [
  join(sourceRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--jsx', 'react-jsx', '--lib', 'ES2022,DOM,DOM.Iterable',
  join(appRoot, 'preview', 'main.ts'), join(appRoot, 'preview', 'vite.config.ts'),
  join(sourceRoot, 'packages', 'pptx-render', 'src', 'bidi-js.d.ts'),
], appRoot);
const viteBin = join(sourceRoot, 'node_modules', 'vite', 'bin', 'vite.js');
run(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts', '--base', './', '--sourcemap'], join(appRoot, 'preview'));

await rm(rendererRoot, { recursive: true, force: true });
await cp(join(appRoot, 'preview', 'dist'), rendererRoot, { recursive: true });
await copyFile(
  join(sourceRoot, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  join(rendererRoot, 'pdf.worker.js'),
);
await copyFile(join(packageRoot, 'src', 'host-policy.css'), join(rendererRoot, 'host-policy.css'));

const indexPath = join(rendererRoot, 'index.html');
const hardened = injectPreviewPolicy(await readFile(indexPath, 'utf8'), {
  policyCssPath: './host-policy.css',
});
if (/\b(?:src|href)="\//u.test(hardened)) {
  throw new Error('preview index contains a Host-root asset path');
}
if (!hardened.includes("connect-src 'none'")) {
  throw new Error('preview CSP is not fail-closed');
}
await writeFile(indexPath, hardened);
const integrity = sha256Sri(await readFile(indexPath));

const manifestPath = join(packageRoot, 'plugin.yaml');
const manifest = parseDocument(await readFile(manifestPath, 'utf8'));
const contributions = manifest.get('contributions');
if (!contributions || typeof contributions.get !== 'function') {
  throw new Error('plugin.yaml has no contributions');
}
let index = -1;
for (let i = 0; i < contributions.items.length; i += 1) {
  const item = contributions.items[i];
  if (item?.get?.('type') === 'content-preview-provider' && item?.get?.('id') === contributionId) {
    index = i;
    break;
  }
}
if (index < 0) throw new Error(`plugin.yaml has no content-preview-provider ${contributionId}`);
manifest.setIn(['contributions', index, 'surface', 'integrity'], integrity);
await writeFile(manifestPath, String(manifest));
run(process.execPath, [join(packageRoot, 'scripts', 'generate-manifest.mjs')], packageRoot);

const entries = (await walkFiles(rendererRoot)).map((path) => `package/renderer/preview/${path}`);
assertPackEntries(entries);
await mkdir(rendererRoot, { recursive: true });

process.stdout.write(
  `${JSON.stringify({ rendererRoot, entrypointIntegrity: integrity, fileCount: entries.length })}\n`,
);
