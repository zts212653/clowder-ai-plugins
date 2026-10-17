import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { callBridge } from './bridge-client.mjs';
import { pluginPaths } from './paths.mjs';
import { CHUNK_BYTES, MAX_IMAGE_BYTES } from './workspace-contract.mjs';
import { WorkspaceJobs } from './workspace-jobs.mjs';

export async function readInputImage(path, view) {
  if (!isAbsolute(path)) throw new Error('ABSOLUTE_IMAGE_PATH_REQUIRED');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_IMAGE_BYTES)
      throw new Error('IMAGE_SIZE_LIMIT');
    const bytes = await file.readFile();
    if (bytes.length !== stat.size || bytes.length > MAX_IMAGE_BYTES)
      throw new Error('INPUT_IMAGE_CHANGED');
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' &&
            bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
    if (!mime) throw new Error('INVALID_IMAGE_BYTES');
    return {
      view,
      path,
      bytes,
      mime,
      name: `${view}.${mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await file.close();
  }
}
export function workspaceClient({
  bridge = callBridge,
  root = join(pluginPaths().root, 'jobs'),
} = {}) {
  const jobs = new WorkspaceJobs(root);
  const call = (payload, signal) => bridge('workspace', { payload, signal });
  return {
    inspect: (signal, page) =>
      call(page ? { kind: 'navigate', page } : { kind: 'inspect' }, signal),
    read: (id) => jobs.read(id),
    async prepare({ job_key, approved_source_ref, images, settings }, signal) {
      const jobId = createHash('sha256').update(job_key).digest('hex');
      try {
        const previous = await jobs.read(jobId);
        if (previous.state !== 'prepared') return previous;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const views = Object.keys(images);
      if (
        (views.length !== 1 && views.length !== 4) ||
        !images.front ||
        (views.length === 4 &&
          !['left', 'right', 'back'].every((v) => images[v]))
      )
        throw new Error('ONE_OR_FOUR_VIEWS_REQUIRED');
      const files = await Promise.all(
        views.map((v) => readInputImage(images[v], v)),
      );
      signal?.throwIfAborted();
      const configured = await call(
        { kind: 'configure', views: views.length, ...settings },
        signal,
      );
      for (const file of files) {
        for (
          let index = 0;
          index < Math.ceil(file.bytes.length / CHUNK_BYTES);
          index++
        ) {
          signal?.throwIfAborted();
          await call(
            {
              kind: 'upload',
              view: file.view,
              name: file.name,
              mime: file.mime,
              sha256: file.sha256,
              bytes: file.bytes.length,
              index,
              total: Math.ceil(file.bytes.length / CHUNK_BYTES),
              data: file.bytes
                .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
                .toString('base64'),
            },
            signal,
          );
        }
      }
      const inputHashes = files.map((f) => ({
        view: f.view,
        path: f.path,
        sha256: f.sha256,
        bytes: f.bytes.length,
      }));
      const preview = await call(
        { kind: 'preview', jobId, sourceRef: approved_source_ref },
        signal,
      );
      const job = await jobs.prepare(job_key, {
        sourceRef: approved_source_ref,
        inputHashes,
        settings,
        browserPreview: { digest: preview.digest, state: preview.state },
      });
      return {
        ...job,
        observed: preview.observed,
        nextAction:
          '按同一已接受任务核对真实参数、可见范围和积分后，使用 jobId + digest 提交；此步骤没有点生成。',
      };
    },
    async submit(jobId, digest, signal) {
      const status = await call({ kind: 'inspect' }, signal);
      if (!status.loggedIn) throw new Error('TRIPO_NOT_LOGGED_IN');
      return jobs.submit(jobId, digest, (draft) =>
        call(
          { kind: 'submit', jobId, previewDigest: draft.browserPreview.digest },
          signal,
        ),
      );
    },
    export: (modelId, format, signal) =>
      call({ kind: 'export', modelId, format }, signal),
    downloadStatus: (exportId, signal) =>
      call({ kind: 'downloads', exportId }, signal),
  };
}
