import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
assert.ok(process.env.ISSUE_WORKBENCH_HOST_ROOT, 'Set ISSUE_WORKBENCH_HOST_ROOT to an already compiled Host checkout; this command never builds or edits Host');
const hostRoot = resolve(process.env.ISSUE_WORKBENCH_HOST_ROOT);
const output = resolve(process.env.ISSUE_WORKBENCH_HOST_OUTPUT ?? join(packageRoot, 'artifacts', 'installed-host-' + new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(output, { recursive: true });
let archive = process.env.ISSUE_WORKBENCH_HOST_ARCHIVE && resolve(process.env.ISSUE_WORKBENCH_HOST_ARCHIVE);
if (!archive) {
  execFileSync('pnpm', ['build'], { cwd: packageRoot, stdio: 'inherit' });
  const [pack] = JSON.parse(execFileSync(process.execPath, ['scripts/pack-publish-artifact.mjs', 'packages/issue-workbench', output],
    { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  writeFileSync(join(output, 'pack.json'), JSON.stringify(pack, null, 2));
  archive = join(output, pack.filename);
}
const result = spawnSync(process.execPath, ['--test', 'test/installed-host.test.mjs'], {
  cwd: packageRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, ISSUE_WORKBENCH_HOST_ROOT: hostRoot, ISSUE_WORKBENCH_HOST_ARCHIVE: archive, ISSUE_WORKBENCH_HOST_REPORT_DIR: output },
});
const log = (result.stdout ?? '') + (result.stderr ?? '');
writeFileSync(join(output, 'host-integration.log'), log);
process.stdout.write(log);
console.log('Host integration evidence: ' + output);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
