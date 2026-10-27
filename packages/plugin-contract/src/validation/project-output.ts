import type { PluginManifest } from '../generated/contract.generated.js';

/** One declaration binds all public entrypoints; internal producer/lookup methods cannot be public. */
export function projectOutputProblem(manifest: PluginManifest): string | undefined {
  const methods = new Set<string>();
  for (const output of manifest.projectOutputs ?? []) {
    if (methods.has(output.method)) return 'duplicate output method';
    methods.add(output.method);
    if (output.method === output.producerMethod || output.method === output.resultMethod || output.producerMethod === output.resultMethod)
      return 'output, producer and lookup methods must be distinct';
    const source = manifest.contributions?.find(c => c.type === 'media-source' && c.id === output.mediaSourceId);
    if (!source) return 'output media source must be declared';
    const owner = manifest.features.find(f => f.contributions?.some(c => c.type === 'media-source' && c.id === output.mediaSourceId));
    if (!owner?.capabilities.includes('project.output.create')) return 'output media feature must request project.output.create';
    let declared = false;
    for (const contribution of manifest.contributions ?? []) {
      const actions = contribution.type === 'mcp' ? contribution.actions ?? [] : contribution.type === 'tool' ? [contribution.action] : [];
      if (actions.some(a => a.method === output.producerMethod || a.method === output.resultMethod)) return 'internal output methods cannot be exposed directly';
      if (!actions.some(a => a.method === output.method)) continue;
      if (contribution.type !== 'mcp') return 'project output currently requires an authenticated native MCP entrypoint';
      if (!owner.contributions?.some(c => c.type === contribution.type && c.id === contribution.id)) return 'output entrypoint and media source must have the same feature owner';
      declared = true;
    }
    if (!declared) return 'output method must be a declared tool or native MCP action';
    for (const field of manifest.configuration ?? [])
      if (field.kind === 'operation' && field.actions?.some(a => [output.method, output.producerMethod, output.resultMethod].includes(a.action.method)))
        return 'project output is unavailable to settings actions';
  }
  return undefined;
}
