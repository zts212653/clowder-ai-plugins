import {createHash} from 'node:crypto';
import {readFile, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

export interface CollectiveClientAsset {readonly bytes: Buffer; readonly contentType: string}
export type CollectiveClientAssets = ReadonlyMap<string, CollectiveClientAsset>;

/** Public build assets may be revalidated; nonce-bearing documents remain no-store.
 * Prepare compression once per Service, never on its request-processing path. */
export function createCollectiveAssetResponder(assets: CollectiveClientAssets | undefined) {
  const prepared = new Map([...assets ?? []].map(([path, asset]) => {
    const html = asset.contentType.startsWith('text/html');
    const compressible = /^(?:text\/(?:javascript|css)|application\/javascript)\b/.test(asset.contentType);
    const compressed = compressible ? gzipSync(asset.bytes) : undefined;
    return [path, {
      ...asset,
      html,
      etag: `W/"${createHash('sha256').update(asset.bytes).digest('hex')}"`,
      gzip: compressed && compressed.length < asset.bytes.length ? compressed : undefined,
    }];
  }));
  return (request: IncomingMessage, response: ServerResponse, path: string, documentNonce: string) => {
    if (request.method !== 'GET') return false;
    const asset = prepared.get(path === '/' ? '/index.html' : path);
    if (!asset) return false;
    response.setHeader('content-type', asset.contentType);
    if (asset.html) {
      const bytes = Buffer.from(asset.bytes.toString('utf8').replace('</head>',
        `<meta name="collective-widget-nonce" content="${documentNonce}"></head>`));
      response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
      return true;
    }
    response.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    response.setHeader('etag', asset.etag);
    response.setHeader('vary', 'Origin, Accept-Encoding');
    const validators = request.headers['if-none-match']?.split(',').map(value => value.trim().replace(/^W\//, ''));
    if (validators?.some(value => value === '*' || value === asset.etag.replace(/^W\//, ''))) {
      response.writeHead(304).end();
      return true;
    }
    const bytes = asset.gzip && acceptsGzip(request.headers['accept-encoding']) ? asset.gzip : asset.bytes;
    if (bytes !== asset.bytes) response.setHeader('content-encoding', 'gzip');
    response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
    return true;
  };
}

function acceptsGzip(header: string | undefined): boolean {
  const encodings = new Map((header ?? '').split(',').map(value => {
    const [name, ...parameters] = value.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    return [name, Number.isFinite(q) && q > 0 && q <= 1];
  }));
  return encodings.get('gzip') ?? encodings.get('*') ?? false;
}

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
