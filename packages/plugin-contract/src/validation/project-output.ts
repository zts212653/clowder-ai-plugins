import type { PluginManifest } from '../generated/contract.generated.js';

/** Binds an output operation to owned native/media declarations, without an API grant table. */
export function projectOutputProblem(manifest: PluginManifest): string | undefined {
  const methods = new Set<string>();
  for (const output of manifest.projectOutputs ?? []) {
    const operationMethods = [output.method, output.producerMethod, output.resultMethod];
    for (const method of operationMethods) {
      if (methods.has(method)) return 'output, producer and lookup methods must be distinct across operations';
      methods.add(method);
    }
    const source = manifest.contributions?.find(c => c.type === 'media-source' && c.id === output.mediaSourceId);
    if (!source) return 'output media source must be declared';
    const owner = manifest.features.find(f => f.contributions?.some(c => c.type === 'media-source' && c.id === output.mediaSourceId));
    const native = manifest.contributions?.find(c => c.type === 'mcp' && c.id === output.mcpId);
    if (!native || !owner?.contributions?.some(c => c.type === 'mcp' && c.id === output.mcpId))
      return 'output native entrypoint and media source must have the same feature owner';
    for (const contribution of manifest.contributions ?? []) {
      if ('action' in contribution && operationMethods.includes(contribution.action.method))
        return 'project output is unavailable to non-native contribution actions';
    }
    for (const field of manifest.configuration ?? [])
      if (field.kind === 'operation' && field.actions?.some(a => operationMethods.includes(a.action.method)))
        return 'project output is unavailable to settings actions';
    if (manifest.test && operationMethods.includes(manifest.test.action.method))
      return 'project output is unavailable to connection tests';
  }
  return undefined;
}
