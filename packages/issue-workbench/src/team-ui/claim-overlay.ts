import type { CoordinationSnapshot } from '../model/issue-coordination.js';
import type { TeamIssue } from '../team/types.js';

/** Reflect the provider read after dispatch immediately, without reloading every repository. */
export function withTeamClaims(snapshot: CoordinationSnapshot, observations: TeamIssue[]): CoordinationSnapshot {
  if (!observations.length) return snapshot;
  return { ...snapshot, sources: snapshot.sources.map(source => {
    const profile = source.profile;
    if (profile.provider !== 'github' || profile.instance !== 'https://github.com' || profile.synthetic || source.error) return source;
    return { ...source, issues: source.issues.map(fact => {
      const current = observations.find(issue => issue.repo === profile.repository && issue.id === fact.id && issue.number === fact.number);
      if (fact.unavailable || !current?.updatedAt || Date.parse(current.updatedAt) < Date.parse(fact.updatedAt)) return fact;
      return { ...fact, assignees: [...current.assignees], state: current.state.toUpperCase() };
    }) };
  }) };
}
