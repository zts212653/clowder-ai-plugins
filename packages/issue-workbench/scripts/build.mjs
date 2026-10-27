import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
process.chdir(root);
rmSync('dist', { recursive: true, force: true });
execFileSync('pnpm', ['exec','tsc'], { stdio: 'inherit' });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'linked' });
const teamBundle = await build({ entryPoints: ['src/team/plugin-entrypoint.ts'], outfile: 'dist/team-plugin.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'linked', metafile: true });
const manifest = parse(readFileSync('plugin.yaml', 'utf8'));
const nativeTools = manifest.contributions.filter(item => item.type === 'tool').map(item => ({
  name: item.name, description: item.description, inputSchema: item.inputSchema, method: item.action.method,
}));
const sdkDirectory = dirname(fileURLToPath(import.meta.resolve('@clowder-ai/plugin-sdk')));
const nativeBundle = await build({ entryPoints: ['src/team/mcp-entrypoint.ts'], outfile: 'dist/team-mcp.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', legalComments: 'linked', metafile: true,
  // This transport uses the public action client only. Unused SDK re-exports initialize
  // unrelated companion/schema features; discard their side effects from this bundle.
  plugins: [{ name: 'action-client-only', setup(build) {
    build.onResolve({ filter: /^\.\.?\/.+\.js$/ }, args => args.importer.startsWith(sdkDirectory + '/')
      ? { path: join(dirname(args.importer), args.path), sideEffects: false } : undefined);
    build.onResolve({ filter: /^@clowder-ai\/plugin-contract(?:\/|$)/ }, async args => {
      if (args.pluginData?.resolved || !args.importer.startsWith(sdkDirectory + '/')) return;
      const result = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } });
      return { ...result, sideEffects: false };
    });
  } }],
  banner: { js: "import { createRequire as createNativeRequire } from 'node:module'; const require = createNativeRequire(import.meta.url);" },
  define: { ISSUE_TEAM_NATIVE_TOOLS: JSON.stringify(nativeTools) } });
await build({ entryPoints: ['src/browser.tsx'], outfile: 'dist/browser.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' });
await build({ entryPoints: ['examples/demo.ts'], outfile: 'dist/demo.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['./browser.js'] });
await build({ entryPoints: ['examples/coordination.ts'], outfile: 'dist/coordination.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['./browser.js'] });
await build({ entryPoints: ['examples/installed.ts'], outfile: 'dist/installed.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['./browser.js'] });
const revision = execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Preview build needs an exact source revision');
writeFileSync('dist/coordination.html', readFileSync('examples/coordination.html','utf8').replace('<html lang="zh-CN">', '<html lang="zh-CN" data-cat-cafe-build-revision="' + revision + '">'));
writeFileSync('dist/installed.html', readFileSync('examples/installed.html','utf8').replace('<html lang="zh-CN">', '<html lang="zh-CN" data-cat-cafe-build-revision="' + revision + '">'));
writeFileSync('dist/coordination-host.mjs', readFileSync('examples/coordination-host.mjs','utf8').replace("'../dist/index.js'", "'./index.js'").replace("new URL('../dist', import.meta.url)", "new URL('.', import.meta.url)"));
mkdirSync('dist', { recursive: true }); copyFileSync('examples/index.html','dist/index.html');

// Ship complete upstream license texts as well as esbuild's linked comments.
for (const name of ['react', 'react-dom', 'scheduler', 'marked', 'dompurify']) {
  const resolver = name === 'scheduler' ? createRequire(require.resolve('react-dom')) : require;
  let directory = dirname(resolver.resolve(name));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Missing package root for ' + name);
    directory = parent;
  }
  const licenses = readdirSync(directory).filter(file => /^license(?:\.|$)/i.test(file));
  if (!licenses.length) throw new Error('Missing license for ' + name);
  mkdirSync(join('dist/licenses', name), { recursive: true });
  for (const file of licenses) copyFileSync(join(directory, file), join('dist/licenses', name, file));
}
// Bundled validator code remains part of the artifact's license closure.
const seenPackages = new Set();
const bundledInputs = [teamBundle, nativeBundle].flatMap(bundle => Object.values(bundle.metafile.outputs)
  .flatMap(output => Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([input]) => input)));
for (const input of new Set(bundledInputs)) {
  let directory = dirname(join(root, input));
  // ESM/CJS subdirectories may contain only a package type marker, not a package.
  while (dirname(directory) !== directory && (!existsSync(join(directory, 'package.json')) ||
    !JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name)) directory = dirname(directory);
  if (!existsSync(join(directory, 'package.json')) || seenPackages.has(directory) || directory === root.replace(/\/$/, '')) continue;
  seenPackages.add(directory);
  const dependency = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const name = dependency.name;
  const licenses = readdirSync(directory).filter(file => /^licen[cs]e(?:\.|$)/i.test(file));
  mkdirSync(join('dist/licenses', name), { recursive: true });
  // First-party workspace packages are covered by this repository's root MIT license.
  if (!licenses.length && ['@clowder-ai/plugin-sdk', '@clowder-ai/plugin-contract'].includes(name)
    && dependency.license === 'MIT' && directory === join(root, '..', name.split('/')[1])) {
    copyFileSync(join(root, '../../LICENSE'), join('dist/licenses', name, 'LICENSE'));
    continue;
  }
  if (!licenses.length) throw new Error('Missing bundled dependency license: ' + name);
  for (const file of licenses) copyFileSync(join(directory, file), join('dist/licenses', name, file));
}
