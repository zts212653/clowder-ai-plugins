import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const folder of ['src', 'web', 'scripts', 'test']) {
  for (const name of readdirSync(resolve(root, folder)).filter((name) => name.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', resolve(root, folder, name)], { stdio: 'inherit', windowsHide: true });
  }
}
