/** Public links emitted by this plugin's read models. Host strips its generic
 * plugin prefix; the embedded router owns the remaining GitHub business path. */
export function communityActionEndpoint(
  resource: 'community-issues' | 'community-findings', id: string, action: string,
): string {
  return `/api/plugins/official.github-operations/github/${resource}/${encodeURIComponent(id)}/${encodeURIComponent(action)}`;
}
