import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MAX_TABS, redactAssetUrl, validateAssetUrl, validateObservation } from './contract.mjs';

const MAX_MODEL_BYTES = 128 * 1024 * 1024;
export async function outputDirectory(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.trim() !== root)
    throw new Error('CONFIGURE_OUTPUT_DIRECTORY');
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('OUTPUT_SYMLINK_NOT_ALLOWED');
  return realpath(root);
}
export function validateGlb(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error('INVALID_GLB');
  const length = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || length > bytes.length - 20) throw new Error('INVALID_GLB_JSON');
  const document = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  if (
    [...(document.buffers ?? []), ...(document.images ?? [])].some((item) => item.uri && !item.uri.startsWith('data:'))
  )
    throw new Error('EXTERNAL_MODEL_DEPENDENCY');
  return { meshCount: document.meshes?.length ?? 0 };
}
export async function downloadGlb(url, path, { fetchAsset = fetch, signal } = {}) {
  signal?.throwIfAborted();
  const safe = validateAssetUrl(url);
  const transferSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const response = await fetchAsset(safe, {
    redirect: 'manual',
    credentials: 'omit',
    signal: transferSignal,
  });
  if (!response.ok || response.status >= 300) throw new Error('ASSET_DOWNLOAD_FAILED');
  if (Number(response.headers.get('content-length')) > MAX_MODEL_BYTES) throw new Error('MODEL_TOO_LARGE');
  const pieces = [];
  let size = 0;
  for await (const piece of response.body) {
    transferSignal.throwIfAborted();
    size += piece.length;
    if (size > MAX_MODEL_BYTES) throw new Error('MODEL_TOO_LARGE');
    pieces.push(piece);
  }
  transferSignal.throwIfAborted();
  const bytes = Buffer.concat(pieces);
  const metrics = validateGlb(bytes);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes, { signal: transferSignal });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), ...metrics };
}
export async function downloadPreviewModel(resources, directory, file, options = {}) {
  const models = [...new Set(resources.filter((url) => /\.glb$/i.test(new URL(url).pathname)))];
  if (models.length !== 1)
    return {
      status: 'unavailable',
      error: models.length ? 'AMBIGUOUS_MODEL_RESOURCES' : 'MODEL_RESOURCE_NOT_OBSERVED',
    };
  try {
    return {
      status: 'downloaded',
      file,
      ...(await downloadGlb(models[0], join(directory, file), options)),
      assetSource: redactAssetUrl(models[0]),
      sourceAssociation: 'single_glb_observed_on_bound_page',
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { status: 'unavailable', error: error.message };
  }
}
export async function collectModels(result, root, options = {}) {
  options.signal?.throwIfAborted();
  if (!Array.isArray(result?.observations) || !result.observations.length || result.observations.length > MAX_TABS)
    throw new Error('INVALID_BATCH');
  let candidates = result.observations.map((value) => validateObservation(value, value.pageUrl));
  if (new Set(candidates.map((c) => c.modelId)).size !== candidates.length) throw new Error('DUPLICATE_SOURCE');
  if (options.modelIds) {
    if (
      !Array.isArray(options.modelIds) ||
      !options.modelIds.length ||
      options.modelIds.length > MAX_TABS ||
      new Set(options.modelIds).size !== options.modelIds.length
    )
      throw new Error('INVALID_CANDIDATE_ORDER');
    const byId = new Map(candidates.map((candidate) => [candidate.modelId, candidate]));
    candidates = options.modelIds.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) throw new Error('REQUESTED_MODEL_NOT_AUTHORIZED');
      return candidate;
    });
  }
  const output = await outputDirectory(root);
  const batchId = `tripo-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(output, batchId);
  await mkdir(directory, { mode: 0o700 });
  try {
    const records = [];
    for (const [index, candidate] of candidates.entries()) {
      options.signal?.throwIfAborted();
      const record = {
        number: index + 1,
        modelId: candidate.modelId,
        pageUrl: candidate.pageUrl,
        title: candidate.title,
        observedAt: candidate.observedAt,
        focus: candidate.focus,
        status: 'unavailable',
      };
      Object.assign(
        record,
        await downloadPreviewModel(candidate.resources, directory, `${index + 1}-${candidate.modelId}.glb`, options),
      );
      records.push(record);
    }
    options.signal?.throwIfAborted();
    const report = { v: 1, batchId, directory, candidates: records, selection: 'pending_human_choice' };
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    return report;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
