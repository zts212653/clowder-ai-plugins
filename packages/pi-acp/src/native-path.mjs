import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Match Pi 1.3 getAgentDir -> normalizePath, including Windows shell drive aliases.
export function resolvePiAgentDir(input = process.env.PI_CODING_AGENT_DIR) {
  const home = homedir();
  if (!input) return join(home, '.pi', 'agent');
  let value = input;
  if (process.platform === 'win32' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const drive = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) value = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  if (value === '~') return home;
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\')))
    return join(home, value.slice(2));
  return /^file:\/\//.test(value) ? fileURLToPath(value) : value;
}
