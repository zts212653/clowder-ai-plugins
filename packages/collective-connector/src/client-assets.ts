import {createHash} from 'node:crypto';
import {readFile, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

export interface CollectiveClientAsset {readonly bytes: Buffer; readonly contentType: string}
export type CollectiveClientAssets = ReadonlyMap<string, CollectiveClientAsset>;

/** Only the existing client's declared, verified files can be served. */
export async function loadCollectiveClient(root: URL) {
  const directory=fileURLToPath(root);
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  if (manifest.version!==1 || manifest.clientBuildId!=='collective-client-v2' || !Array.isArray(manifest.files))
    throw new Error('Invalid Collective client manifest');
  const files=new Map<string,CollectiveClientAsset>();
  for (const row of manifest.files) {
    if (typeof row.path!=='string' || !/^\/(?:index\.html|collective-client\/[A-Za-z0-9_.-]+)$/.test(row.path) || files.has(row.path) ||
      typeof row.contentType!=='string' || /[\r\n]/.test(row.contentType)) throw new Error('Invalid Collective client asset');
    const path=join(directory,row.path.slice(1));
    if (!(await lstat(path)).isFile()) throw new Error('Collective client assets must be regular files');
    const bytes=await readFile(path);
    if (bytes.length!==row.size || createHash('sha256').update(bytes).digest('hex')!==row.sha256)
      throw new Error('Collective client asset digest mismatch');
    files.set(row.path,{bytes,contentType:row.contentType});
  }
  if (!files.has('/index.html')) throw new Error('Collective client index is missing');
  return {clientBuildId:'collective-client-v2',files};
}
