import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function pluginPaths(home = homedir()) {
  const root = join(home, '.cat-cafe', 'tripo-studio');
  const socketId = createHash('sha256').update(root).digest('hex').slice(0, 24);
  return {
    root,
    record: join(root, 'pairing.json'),
    socket: `/tmp/catcafe-tripo-${socketId}.sock`,
    versions: join(root, 'versions'),
  };
}
