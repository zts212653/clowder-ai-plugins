import { fileURLToPath } from 'node:url';
import { synchronize, verify } from './sync-engine.mjs';
import { mappings } from './source-map.mjs';
const dest = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--verify') console.log(JSON.stringify(verify(dest)));
  else {
    const mode = args.shift(); const [sourceFlag, source, refFlag, ref] = args;
    if (!['--check','--write'].includes(mode) || sourceFlag !== '--source' || refFlag !== '--ref' || args.length !== 4) throw new Error('Usage: sync-from-core.mjs --check|--write --source <checkout> --ref <40-char SHA>; or --verify');
    console.log(JSON.stringify(synchronize({ source, dest, ref, mappings, mode: mode.slice(2) })));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
