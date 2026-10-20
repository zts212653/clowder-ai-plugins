// Runs in the authorized page's MAIN world. It cannot receive code or selectors from callers.
export function readTripoPage() {
  const resources = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length <= 8192 && resources.size < 256) resources.add(value);
  };
  for (const entry of performance.getEntriesByType('resource')) {
    if (/\.(?:glb|gltf|png|jpe?g|webp)(?:[?#]|$)/i.test(entry.name)) add(entry.name);
  }
  for (const element of document.querySelectorAll('model-viewer[src], a[href], img[src]')) {
    const value = element.currentSrc || element.src || element.href;
    if (/\.(?:glb|gltf|png|jpe?g|webp)(?:[?#]|$)/i.test(value ?? '')) add(value);
  }
  return {
    v: 1,
    pageUrl: location.href,
    title: document.title.slice(0, 512),
    resources: [...resources],
    observedAt: new Date().toISOString(),
  };
}
