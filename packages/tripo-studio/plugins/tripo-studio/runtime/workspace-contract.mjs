export const WORKSPACE_URL = 'https://studio.tripo3d.ai/workspace/generate';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const CHUNK_BYTES = 192 * 1024;
const id = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function isWorkspaceUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.origin === 'https://studio.tripo3d.ai' &&
      /^\/workspace\/(generate|rigging|animate)\/?$/.test(u.pathname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function validateWorkspaceRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_WORKSPACE_REQUEST');
  const allowed = {
    inspect: ['kind'],
    navigate: ['kind', 'page'],
    configure: ['kind', 'mode', 'views', 'privacy', 'topology', 'polycount'],
    upload: [
      'kind',
      'view',
      'name',
      'mime',
      'sha256',
      'bytes',
      'index',
      'total',
      'data',
    ],
    preview: ['kind', 'jobId', 'sourceRef'],
    submit: ['kind', 'jobId', 'previewDigest'],
    export: ['kind', 'modelId', 'format'],
    downloads: ['kind', 'exportId'],
  }[value.kind];
  if (!allowed || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('INVALID_WORKSPACE_OPERATION');
  if (
    value.kind === 'navigate' &&
    !['generate', 'rigging', 'animate'].includes(value.page)
  )
    throw new Error('INVALID_WORKSPACE_PAGE');
  if (
    value.kind === 'configure' &&
    (!['HD Model', 'Smart Mesh'].includes(value.mode) ||
      ![1, 4].includes(value.views) ||
      !['Private', 'Share Only', 'Public'].includes(value.privacy) ||
      (value.topology !== undefined &&
        !['Quad', 'Triangle'].includes(value.topology)) ||
      (value.polycount !== undefined &&
        (!Number.isInteger(value.polycount) ||
          value.polycount < 500 ||
          value.polycount > 25000)))
  )
    throw new Error('INVALID_WORKSPACE_SETTINGS');
  if (
    value.kind === 'upload' &&
    (!['front', 'left', 'right', 'back'].includes(value.view) ||
      !/^[A-Za-z0-9_-]{1,80}\.(png|jpe?g|webp)$/.test(value.name) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(value.mime) ||
      !id(value.sha256) ||
      !Number.isInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > MAX_IMAGE_BYTES ||
      !Number.isInteger(value.index) ||
      !Number.isInteger(value.total) ||
      value.index < 0 ||
      value.index >= value.total ||
      value.total !== Math.ceil(value.bytes / CHUNK_BYTES) ||
      typeof value.data !== 'string' ||
      value.data.length > (CHUNK_BYTES * 4) / 3 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
  )
    throw new Error('INVALID_IMAGE_CHUNK');
  if (['preview', 'submit'].includes(value.kind) && !id(value.jobId))
    throw new Error('INVALID_JOB_ID');
  if (
    value.kind === 'preview' &&
    (typeof value.sourceRef !== 'string' ||
      value.sourceRef.length < 1 ||
      value.sourceRef.length > 512)
  )
    throw new Error('APPROVED_SOURCE_REQUIRED');
  if (value.kind === 'submit' && !id(value.previewDigest))
    throw new Error('INVALID_PREVIEW_DIGEST');
  if (
    value.kind === 'export' &&
    (!uuid(value.modelId) || !['glb', 'fbx'].includes(value.format))
  )
    throw new Error('INVALID_EXPORT');
  if (value.kind === 'downloads' && !uuid(value.exportId))
    throw new Error('INVALID_EXPORT_ID');
  return value;
}
