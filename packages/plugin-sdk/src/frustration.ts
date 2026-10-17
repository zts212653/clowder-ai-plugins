import { assertFrustrationContract, type FrustrationSource, type FrustrationLinkDraftInput, type FrustrationLinkDraftResult } from '@clowder-ai/plugin-contract';
export interface PluginFrustrationHost {
  getSource(issueId: string): Promise<FrustrationSource | null>;
  /** Host authenticates owner/native context. Replacement of a different non-null
   * link requires a live owner HTTP request; this port grants no publish authority. */
  linkDraft(input: FrustrationLinkDraftInput): Promise<FrustrationLinkDraftResult>;
}
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(copy); return copy;
}
export function createFrustrationClient(host: PluginFrustrationHost | undefined, assertGranted: (needed: readonly ('frustration.read' | 'frustration.link')[]) => void): PluginFrustrationHost {
  return {
    async getSource(issueId) {
      assertGranted(['frustration.read']); assertFrustrationContract('FrustrationSourceId', issueId);
      if (!host) throw new Error('Host frustration port unavailable');
      const value = await host.getSource(issueId);
      assertGranted(['frustration.read']);
      if (value === null) return null;
      assertFrustrationContract('FrustrationSource', value);
      if (value.issueId !== issueId) throw new TypeError('Frustration source mismatch');
      return snapshot(value);
    },
    async linkDraft(input) {
      const grants = ['frustration.read', 'frustration.link'] as const;
      assertGranted(grants); assertFrustrationContract('FrustrationLinkDraftInput', input);
      if (!host) throw new Error('Host frustration port unavailable');
      const request = snapshot(input);
      const result = await host.linkDraft(request);
      assertGranted(grants); assertFrustrationContract('FrustrationLinkDraftResult', result);
      if ((result.outcome === 'linked' || result.outcome === 'already_linked') &&
          (result.draftId !== request.draftId || result.sourceRevision !== request.sourceRevision)) throw new TypeError('Frustration link result mismatch');
      return snapshot(result);
    },
  };
}
