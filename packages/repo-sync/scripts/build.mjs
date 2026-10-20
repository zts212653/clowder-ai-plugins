import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = parse(await readFile(resolve(root, 'plugin.yaml'), 'utf8'));
const result = validateManifest(manifest);
if (!result.valid) throw new Error(JSON.stringify(result.errors));
const destination = resolve(root, 'dist');
await mkdir(destination, { recursive: true });
const sourceNames = await readdir(resolve(root, 'src'));
const oldNames = await readdir(destination);
if (oldNames.some((name) => !sourceNames.includes(name)))
  throw new Error('Generated dist contains stale files; inspect before rebuilding');
for (const name of sourceNames) await cp(resolve(root, 'src', name), resolve(destination, name));
console.log('repo-sync: manifest validated and self-contained runtime built');
