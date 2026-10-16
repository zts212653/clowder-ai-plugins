import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { outputDirectory } from './assets.mjs';
import { MAX_TABS } from './contract.mjs';

export async function exportSelected(root, batchId, number, filename, { signal } = {}) {
  signal?.throwIfAborted();
  if (
    !/^tripo-[A-Za-z0-9-]{20,100}$/.test(batchId) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > MAX_TABS ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.glb$/.test(filename)
  )
    throw new Error('INVALID_EXPORT_SELECTION');
  const output = await outputDirectory(root);
  const batch = join(output, batchId);
  if ((await realpath(batch)) !== batch) throw new Error('BATCH_SYMLINK_NOT_ALLOWED');
  const reportPath = join(batch, 'provenance.json');
  if ((await lstat(reportPath)).isSymbolicLink()) throw new Error('PROVENANCE_SYMLINK_NOT_ALLOWED');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const candidate = report.candidates.find((c) => c.number === number && c.status === 'downloaded');
  if (!candidate || typeof candidate.file !== 'string' || candidate.file !== `${number}-${candidate.modelId}.glb`)
    throw new Error('MODEL_NOT_DOWNLOADED');
  const source = resolve(batch, candidate.file);
  if (!source.startsWith(`${batch}${sep}`) || (await realpath(source)) !== source)
    throw new Error('SOURCE_OUTSIDE_BATCH');
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw new Error('MODEL_DIGEST_CHANGED');
  const destination = join(output, filename);
  const receipt = {
    v: 1,
    batchId,
    number,
    modelId: candidate.modelId,
    pageUrl: candidate.pageUrl,
    file: destination,
    sha256: candidate.sha256,
    bytes: bytes.length,
  };
  signal?.throwIfAborted();
  const modelHandle = await open(destination, 'wx', 0o600);
  let receiptHandle;
  try {
    try {
      await modelHandle.writeFile(bytes, { signal });
    } finally {
      await modelHandle.close();
    }
    signal?.throwIfAborted();
    receiptHandle = await open(`${destination}.source.json`, 'wx', 0o600);
    await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, { signal });
  } catch (error) {
    await unlink(destination);
    if (receiptHandle) await unlink(`${destination}.source.json`);
    throw error;
  } finally {
    await receiptHandle?.close();
  }
  return receipt;
}
