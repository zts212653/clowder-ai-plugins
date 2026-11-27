import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['@clowder-ai/plugin-sdk'],
  // Any transitively-inlined CommonJS dependency would otherwise compile to an
  // esbuild `__require` shim that throws `Dynamic require of "x" is not
  // supported`: the emitted file is ESM, where no `require` binding exists. The
  // Host loads this entrypoint with `import()`, so the failure surfaces only as
  // an activation error. Binding a real `require` up front keeps every inlined
  // dependency loadable, present or future.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  allowOverwrite: true,
  logLevel: 'warning',
});
