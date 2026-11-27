import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The memory wire contract lives on its own version line and is not published to
// a registry: the Host vendors the identical tgz. A catalog package may not ship
// its own node_modules, and the Host materializes only exact registry versions,
// so an external contract import would never resolve inside the installed worker.
// Inline that one module into every emitted entry; the SDK stays external because
// the Host materializes it from this package's own shrinkwrap.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

async function emittedModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return emittedModules(path);
      return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
    }),
  );
  return nested.flat();
}

await build({
  entryPoints: await emittedModules(dist),
  outdir: dist,
  outbase: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['@clowder-ai/plugin-sdk', 'better-sqlite3'],
  // ESM bundles can still contain CommonJS packages that load Node built-ins.
  banner: {
    js: "import { createRequire as requireFromBundle } from 'node:module';\nconst require = requireFromBundle(import.meta.url);",
  },
  allowOverwrite: true,
  logLevel: 'warning',
});

// The Host installs dependencies with lifecycle scripts disabled. Stage the
// tested native binary inside our archive so activation never builds or fetches it.
const require = createRequire(import.meta.url);
const sqlitePackage = dirname(require.resolve('better-sqlite3/package.json'));
const nativeDir = join(dist, 'native');
const localName = `${process.platform}-${process.arch}-abi${process.versions.modules}.node`;
await mkdir(nativeDir, { recursive: true });
const verifiedBindings = process.env.CLOWDER_MEMORY_NATIVE_DIR;
if (verifiedBindings) {
  const names = (await readdir(verifiedBindings)).filter((name) => /^[a-z0-9]+-[a-z0-9]+-abi[0-9]+\.node$/u.test(name));
  if (!names.includes(localName)) throw new Error(`Missing locally testable SQLite binary ${localName}`);
  await Promise.all(names.map((name) => copyFile(join(verifiedBindings, name), join(nativeDir, name))));
} else {
  await copyFile(join(sqlitePackage, 'build', 'Release', 'better_sqlite3.node'), join(nativeDir, localName));
}

// Stage the vec0 extension for the current build platform. It is a build-time
// dependency only, so installed workers do not resolve it from node_modules.
const platform = `${process.platform}-${process.arch}`;
if (['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(platform)) {
  const extension = require('sqlite-vec').getLoadablePath();
  await copyFile(extension, join(nativeDir, basename(extension)));
}
