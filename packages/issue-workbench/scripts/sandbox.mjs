import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSandboxRoot, startSandbox } from './sandbox/server.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
if (!process.env.ISSUE_WORKBENCH_HOST_ROOT || !process.env.ISSUE_WORKBENCH_SANDBOX_DATA) {
  throw new Error('Set ISSUE_WORKBENCH_HOST_ROOT to an existing compiled Host and ISSUE_WORKBENCH_SANDBOX_DATA to a separate persistent test directory. Host is never built or changed.');
}
const root = resolve(process.env.ISSUE_WORKBENCH_SANDBOX_DATA);
await prepareSandboxRoot(root, process.env.ISSUE_WORKBENCH_HOST_ROOT);
const output = join(root, 'package'); mkdirSync(output, { recursive: true });
let archive = process.env.ISSUE_WORKBENCH_HOST_ARCHIVE;
if (!archive && existsSync(join(root, 'sandbox.json'))) archive = JSON.parse(readFileSync(join(root, 'sandbox.json'), 'utf8')).archive;
if (!archive) {
  execFileSync('pnpm', ['build'], { cwd: packageRoot, stdio: 'inherit' });
  const [pack] = JSON.parse(execFileSync(process.execPath, ['scripts/pack-publish-artifact.mjs', 'packages/issue-workbench', output],
    { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  writeFileSync(join(output, 'pack.json'), JSON.stringify(pack, null, 2)); archive = join(output, pack.filename);
}
const app = await startSandbox({ root, hostRoot: process.env.ISSUE_WORKBENCH_HOST_ROOT, archive,
  port: Number(process.env.PORT ?? 5200), allowArchiveUpgrade: process.env.ISSUE_WORKBENCH_SANDBOX_UPGRADE === '1' });
console.log('Interactive Issue sandbox: ' + app.url + '; persistent data: ' + root);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
