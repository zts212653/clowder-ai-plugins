import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(root, 'source-lock.json'), 'utf8'));
const source = join(root, '.tmp', 'source', lock.rootDirectory);
const entry = join(root, 'worker-source', 'worker.ts');
const engine = join(source, 'packages', 'docx-engine', 'src', 'index.ts');
const jszip = join(source, 'node_modules', 'jszip');
const aliases = { '@genoffice/docx-engine': [engine], jszip: [join(jszip, 'index.d.ts')] };
await mkdir(join(root, '.tmp'), { recursive: true });
const config = join(root, '.tmp', 'semantic-tsconfig.json');
await writeFile(config, JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM', 'WebWorker'],
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
    types: ['node'], typeRoots: [join(source, 'node_modules', '@types')],
    paths: aliases,
  }, files: [entry],
}, null, 2));
const checked = spawnSync(process.execPath, [join(source, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
if (checked.status !== 0) throw new Error('semantic worker typecheck failed');
const { build } = await import(pathToFileURL(join(source, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
const result = await build({
  root, configFile: false, logLevel: 'warn',
  resolve: { alias: { '@genoffice/docx-engine': engine, jszip: join(jszip, 'lib', 'index.js') } },
  build: {
    write: false, minify: true, target: 'es2022', sourcemap: false,
    lib: { entry, formats: ['es'], fileName: () => 'semantic-worker.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(result) ? result.flatMap(row => row.output) : result.output);
if (output.length !== 1 || output[0].type !== 'chunk' || output[0].imports.length || output[0].dynamicImports.length) {
  throw new Error('semantic worker must be one closed bundle without imports or other assets');
}
await writeFile(join(root, 'renderer', 'semantic-worker.js'), output[0].code);
const tested = spawnSync(process.execPath, ['--test', join(root, 'scripts', 'semantic-artifact.test.mjs')], { stdio: 'inherit' });
if (tested.status !== 0) throw new Error('actual semantic bundle regression failed');
