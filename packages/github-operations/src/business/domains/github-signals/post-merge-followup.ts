/** One reminder for tracking, repository inbox and retained lifecycle notifications. */
export const POST_MERGE_FOLLOWUP = [
  '**Post-merge: intake / delivery remains**',
  '- Read the repository\'s post-merge workflow now. For upstream/community changes, continue downstream intake or backport; verify and record already-present or public-only dispositions too.',
  '- Whoever clicked merge, the responsible execution thread continues through intake. A review-only recipient must hand outstanding intake to the named execution owner; the original maintainer / routing thread coordinates and verifies that handoff, rather than becoming the implementation site. Do not leave it for a periodic sync to discover.',
  '- Report upstream merged / intake status / owner / next step. Review completion, a closed issue or a retired subscription does not complete the whole work.',
  '- Continue within existing authority; this notification does not grant new implementation, merge or deployment permission.',
].join('\n');
