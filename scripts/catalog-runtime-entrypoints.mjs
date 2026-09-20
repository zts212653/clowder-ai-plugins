export function assertPackedRuntimeEntrypoints(manifest, artifactFiles) {
  const packedMembers = new Set(artifactFiles.map(file => typeof file === 'string' ? file : file.path));
  const entrypoints = [
    ...(manifest.runtime?.transport === 'builtin' ? [] : [manifest.runtime?.entrypoint]),
    ...(manifest.contributions ?? []).flatMap(entry => entry.runtime ? [entry.runtime.entrypoint] : []),
  ];

  for (const entrypoint of entrypoints) {
    if (typeof entrypoint !== 'string' || !packedMembers.has(entrypoint)) {
      throw new Error(`packed artifact is missing declared runtime entrypoint ${String(entrypoint)}`);
    }
  }
}
