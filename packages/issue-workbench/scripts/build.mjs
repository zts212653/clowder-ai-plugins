import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
rmSync('dist', { recursive: true, force: true });
execFileSync('pnpm', ['exec','tsc'], { stdio: 'inherit' });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'linked' });
await build({ entryPoints: ['src/browser.tsx'], outfile: 'dist/browser.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' });
await build({ entryPoints: ['examples/demo.ts'], outfile: 'dist/demo.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['./browser.js'] });
await build({ entryPoints: ['examples/coordination.ts'], outfile: 'dist/coordination.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['./browser.js'] });
const revision = execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Preview build needs an exact source revision');
writeFileSync('dist/coordination.html', readFileSync('examples/coordination.html','utf8').replace('<html lang="zh-CN">', '<html lang="zh-CN" data-cat-cafe-build-revision="' + revision + '">'));
writeFileSync('dist/coordination-host.mjs', readFileSync('examples/coordination-host.mjs','utf8').replace("'../dist/index.js'", "'./index.js'").replace("new URL('../dist', import.meta.url)", "new URL('.', import.meta.url)"));
mkdirSync('dist', { recursive: true }); copyFileSync('examples/index.html','dist/index.html');

// Ship complete upstream license texts as well as esbuild's linked comments.
const require = createRequire(import.meta.url);
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
