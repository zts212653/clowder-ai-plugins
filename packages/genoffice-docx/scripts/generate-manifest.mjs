import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
const result = validateManifest(manifest);
if (!result.valid) throw new Error(`Invalid plugin manifest: ${JSON.stringify(result.errors)}`);
await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
