import { assertDeploymentCatalog, type DeploymentCatalog } from '@clowder-ai/plugin-contract';
export interface PluginDeploymentHost {
  getCatalog(): Promise<DeploymentCatalog>;
}
/** Feature scope is fenced here; installation/grant freshness remains Host-owned. */
export function createDeploymentClient(host: PluginDeploymentHost | undefined, assertActive: () => void): PluginDeploymentHost {
  return { async getCatalog() {
    assertActive();
    if (!host) throw new Error('Host deployment port unavailable');
    const value = await host.getCatalog();
    assertActive(); assertDeploymentCatalog(value);
    const copy = structuredClone(value);
    for (const entry of Object.values(copy.roster)) Object.freeze(entry);
    Object.freeze(copy.roster); Object.freeze(copy.policy);
    return Object.freeze(copy);
  } };
}
