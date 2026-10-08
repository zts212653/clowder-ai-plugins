import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Gate (review round 6, B4 class): every publishable package's `npm pack`
// must succeed WITH lifecycle scripts. The catalog pipeline packs with
// `--ignore-scripts`, so a broken prepack (e.g. a packlist entry outside the
// declared distribution allowlist) is invisible to catalog:check and only
// explodes in the post-merge publish job. Running pack with scripts on the PR
// makes that class red before merge.

// Explicit exemption — NOT a silent skip. @clowder-ai/feishu-meeting-intake is
// the only package with bundledDependencies, and on Linux + pnpm symlink
// trees `npm pack --dry-run` for it dies inside npm itself ("Exit handler
// never called!", exit 1) — an npm-internal failure, not a package defect.
// The real publish path never runs its prepack: publish-prerelease packs with
// --ignore-scripts (action.yml) and publishes the prebuilt tarball, so this
// gate cannot make that package's release any safer. If intake ever gains a
// real prepack, this exemption must be revisited.
const PACK_WITH_SCRIPTS_EXEMPT = new Set(['@clowder-ai/feishu-meeting-intake']);

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const packed = [];
const exempted = [];

for (const name of readdirSync(join(root, 'packages')).sort()) {
  const manifestPath = join(root, 'packages', name, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue; // not a package directory
  }
  if (manifest.private === true) continue;
  if (PACK_WITH_SCRIPTS_EXEMPT.has(manifest.name)) {
    exempted.push(`${manifest.name} (exempt: npm-internal pack failure, real publish path uses --ignore-scripts)`);
    continue;
  }
  const hasPrepack = manifest.scripts?.prepack !== undefined;
  try {
    // No --ignore-scripts: prepack must run and pass. --dry-run avoids
    // leaving tarballs behind; scripts still execute.
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: join(root, 'packages', name),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 16 * 1024 * 1024,
    });
    packed.push(`${manifest.name}${hasPrepack ? ' (prepack)' : ''}`);
  } catch (error) {
    failures.push(`${manifest.name}: npm pack failed (exit ${error.status ?? 'unknown'})`);
  }
}

for (const line of packed) process.stdout.write(`ok   ${line}\n`);
for (const line of exempted) process.stdout.write(`SKIP ${line}\n`);
if (failures.length > 0) {
  for (const line of failures) process.stderr.write(`FAIL ${line}\n`);
  process.exit(1);
}
process.stdout.write(`pack gate: ${packed.length} publishable packages pack clean, ${exempted.length} exempt\n`);
