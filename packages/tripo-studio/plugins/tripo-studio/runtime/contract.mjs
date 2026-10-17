export const VERSION = '0.2.0';
export const HOST_NAME = 'ai.catcafe.tripo_studio';
export const MAX_TABS = 8;
export const MAX_RESOURCES = 256;
export function assertSameModelPage(pageUrl, expectedModelId) {
  if (parseModelPage(pageUrl).modelId !== expectedModelId)
    throw new Error('SHARED_PAGE_CHANGED');
}
const ASSET_HOSTS = new Set([
  'tripo-data-public.rg1.data.tripo3d.com',
  'tripo-data.rg1.data.tripo3d.com',
  'tripo-public.tripo3d.ai',
  'tripo-webapp-assets.tripo3d.ai',
  'staticassets.tripo3d.ai',
  'tripo-community-public.s3.us-west-2.amazonaws.com',
]);
export function parseModelPage(value) {
  const url = new URL(value);
  const modelId = url.pathname.match(
    /^\/3d-model\/[a-zA-Z0-9-]*?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/,
  )?.[1];
  if (
    url.origin !== 'https://studio.tripo3d.ai' ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) => key !== 'invite_code') ||
    (url.searchParams.has('invite_code') &&
      !/^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get('invite_code'))) ||
    url.hash ||
    !modelId
  )
    throw new Error('INVALID_MODEL_PAGE');
  return { pageUrl: url.href, modelId };
}
export function validateAssetUrl(value) {
  if (typeof value !== 'string' || value.length > 8192)
    throw new Error('INVALID_ASSET_URL');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !ASSET_HOSTS.has(url.hostname)
  )
    throw new Error('ASSET_HOST_NOT_ALLOWED');
  return url.href;
}
export function redactAssetUrl(value) {
  const url = new URL(validateAssetUrl(value));
  return `${url.origin}${url.pathname}`;
}
function validFocus(value) {
  return (
    value &&
    Number.isInteger(value.focusedWindowId) &&
    Array.isArray(value.activeTabs) &&
    value.activeTabs.length <= 64 &&
    value.activeTabs.every(
      (t) => Number.isInteger(t.windowId) && Number.isInteger(t.tabId),
    )
  );
}
export function validateObservation(value, boundPage) {
  const source = parseModelPage(boundPage);
  if (
    value?.v !== 1 ||
    value.pageUrl !== source.pageUrl ||
    typeof value.title !== 'string' ||
    value.title.length > 512 ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    throw new Error('PAGE_CHANGED_OR_INVALID');
  if (!Array.isArray(value.resources) || value.resources.length > MAX_RESOURCES)
    throw new Error('RESOURCE_LIMIT');
  if (!validFocus(value.before) || !validFocus(value.after))
    throw new Error('FOCUS_EVIDENCE_MISSING');
  if (JSON.stringify(value.before) !== JSON.stringify(value.after))
    throw new Error('FOREGROUND_CHANGED');
  return {
    ...source,
    title: value.title,
    resources: [...new Set(value.resources.map(validateAssetUrl))],
    observedAt: value.observedAt,
    focus: { before: value.before, after: value.after },
  };
}
