import { constants } from 'node:fs';
import { open, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, extname } from 'node:path';

export function inspectGlb(bytes) {
  if (
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new Error('INVALID_GLB');
  const length = bytes.readUInt32LE(12);
  if (length > bytes.length - 20) throw new Error('INVALID_GLB');
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  if (
    [...(doc.buffers ?? []), ...(doc.images ?? [])].some(
      (item) => item.uri && !item.uri.startsWith('data:'),
    )
  )
    throw new Error('GLB_EXTERNAL_RESOURCE');
  const primitives = (doc.meshes ?? []).flatMap((m) => m.primitives ?? []);
  const triangles = primitives
    .filter((p) => (p.mode ?? 4) === 4)
    .reduce(
      (sum, p) =>
        sum +
        (doc.accessors?.[p.indices ?? p.attributes?.POSITION]?.count ?? 0) / 3,
      0,
    );
  return {
    vertices: primitives.reduce(
      (sum, p) => sum + (doc.accessors?.[p.attributes?.POSITION]?.count ?? 0),
      0,
    ),
    triangles: primitives.every((p) => (p.mode ?? 4) === 4) ? triangles : null,
    skins: doc.skins?.length ?? 0,
    animations: (doc.animations ?? []).map((a) => a.name ?? null),
    textures: doc.textures?.length ?? 0,
    positionBounds: primitives.map((p) => ({
      min: doc.accessors?.[p.attributes?.POSITION]?.min ?? null,
      max: doc.accessors?.[p.attributes?.POSITION]?.max ?? null,
    })),
    dimensionNote:
      'Accessor bounds are local mesh coordinates; world scale and physical dimensions require Blender inspection.',
  };
}
export async function collectOfficialExport(
  receipt,
  directory,
  filename,
  { signal } = {},
) {
  if (
    receipt?.state !== 'complete' ||
    !isAbsolute(receipt.filename ?? '') ||
    !['glb', 'fbx'].includes(receipt.format) ||
    extname(receipt.filename).toLowerCase() !== `.${receipt.format}`
  )
    throw new Error('OFFICIAL_DOWNLOAD_NOT_COMPLETE');
  if (
    !isAbsolute(directory) ||
    !new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${receipt.format}$`).test(
      filename,
    )
  )
    throw new Error('INVALID_EXPORT_DESTINATION');
  signal?.throwIfAborted();
  const source = await open(
    receipt.filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes;
  try {
    const stat = await source.stat();
    if (
      !stat.isFile() ||
      stat.size < 24 ||
      stat.size > 128 * 1024 * 1024 ||
      stat.size !== receipt.bytes
    )
      throw new Error('DOWNLOAD_SIZE_MISMATCH');
    bytes = await source.readFile();
  } finally {
    await source.close();
  }
  signal?.throwIfAborted();
  const mesh =
    receipt.format === 'glb'
      ? inspectGlb(bytes)
      : {
          inspection:
            'FBX requires Blender inspection; no mesh/skeleton/clip counts inferred.',
        };
  if (
    receipt.format === 'fbx' &&
    !bytes.toString('ascii', 0, 23).startsWith('Kaydara FBX Binary') &&
    !bytes.toString('ascii', 0, 1024).includes('FBXHeaderExtension')
  )
    throw new Error('INVALID_FBX');
  await mkdir(directory, { recursive: true });
  const output = join(directory, filename),
    provenance = `${output}.provenance.json`;
  const metadata = {
    ...receipt,
    filename: output,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mesh,
    source: 'supplier-web-download',
    savedAt: new Date().toISOString(),
  };
  // Reserve receipt first; an existing asset or receipt is never overwritten.
  const file = await open(provenance, 'wx', 0o600);
  let created = false;
  try {
    signal?.throwIfAborted();
    const asset = await open(output, 'wx', 0o600);
    created = true;
    try {
      await asset.writeFile(bytes);
      await asset.sync();
    } finally {
      await asset.close();
    }
    await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
    await file.sync();
  } catch (error) {
    if (created) await rm(output, { force: true });
    await rm(provenance, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  return metadata;
}
