import { isAbsolute, resolve } from 'node:path';
import { safeUrl } from './config.mjs';

// Canonicalize common clone URL spellings for local ownership admission only.
// Ledger binding IDs deliberately retain their original spelling and never change.
export function receivingRepositoryKey(value) {
  value = safeUrl(value, true);
  if (isAbsolute(value)) {
    const path = resolve(value);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }
  const scp = /^git@([\w.-]+):(.+)$/.exec(value);
  const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
  const port = url.port && !(url.protocol === 'ssh:' && url.port === '22') ? `:${url.port}` : '';
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+/, '');
  return `${url.hostname.toLowerCase()}${port}/${path}`;
}
