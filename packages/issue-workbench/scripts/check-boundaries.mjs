import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from './sync-engine.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
verify(root);
function scan(dir) { for (const file of readdirSync(dir, { withFileTypes:true })) {
  const path = join(dir,file.name); if (file.isDirectory()) scan(path);
  else if (/\.[cm]?[jt]sx?$/.test(file.name) && /@cat-cafe\/|from ['"]@\/|buildGhCliEnv|\/Users\/|issue-snapshot\.json/.test(readFileSync(path,'utf8'))) throw new Error('Private Core dependency in ' + path);
} }
scan(join(root,'src'));
const pkg = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.peerDependencies ?? {}).length) throw new Error('Update artifact closure tests before adding runtime/peer dependencies');
const status = JSON.parse(readFileSync(join(root,'integration.json'),'utf8'));
if (status.stage !== 'pre-sdk-package' || status.hostInstallable !== false) throw new Error('SDK cutover needs explicit installed journey evidence');
console.log('Export hashes, private-import boundary and pre-SDK status verified');
