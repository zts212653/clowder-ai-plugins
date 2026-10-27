import type { CoordinationSnapshot, IssueClassification } from '../model/issue-coordination.js';
import type { TeamClassification } from '../team/records.js';
import { classifyIssueContext } from '../classification/issue-context.js';

/** A read projection of persisted cat results. Never edits source labels or local work. */
export function withTeamClassifications(snapshot: CoordinationSnapshot, results: TeamClassification[] = []): CoordinationSnapshot {
  if (!results.length) return snapshot;
  const ordered = [...results].sort((a, b) => b.recordedAt - a.recordedAt || b.id.localeCompare(a.id));
  return { ...snapshot, sources: snapshot.sources.map(source => {
    const profile = source.profile;
    if (profile.provider !== 'github' || profile.instance !== 'https://github.com' || profile.synthetic || source.error) return source;
    const proposals: IssueClassification[] = [];
    for (const fact of source.issues) {
      if (fact.unavailable) continue;
      // Catalogs omit bodies: use the provider's exact update stamp, and compare
      // the body too when present. Legacy records need a fresh verified detail.
      const match = ordered.find(({ issue, verifiedUpdatedAt }) => issue.repo === profile.repository && issue.id === fact.id && issue.number === fact.number
        && !!fact.updatedAt && (issue.updatedAt === fact.updatedAt || verifiedUpdatedAt === fact.updatedAt) && issue.title === fact.title
        && (fact.body === undefined || issue.body === fact.body) && issue.state === fact.state.toLowerCase()
        && (!fact.author || fact.author === issue.author)
        && JSON.stringify([...issue.labels].sort()) === JSON.stringify([...fact.labels].sort()));
      if (!match) continue;
      proposals.push({ id: 'team:' + match.id, model: '研判猫 ' + match.catId, generatedAt: new Date(match.recordedAt).toISOString(),
        source: { provider: profile.provider, instance: profile.instance, repositoryId: profile.repositoryId,
          issueId: match.issue.id, number: fact.number, updatedAt: fact.updatedAt, bodySha256: match.bodySha256 },
        labels: { area: [match.analysis.category], kind: [], symptom: [], environment: [] }, evidence: match.analysis.evidence,
        context: { ...classifyIssueContext(match.issue), ...(match.analysis.affectedSystems !== undefined ? { systems: match.analysis.affectedSystems, systemsSource: 'cat' as const, systemEvidence: [match.analysis.evidence] } : {}) } });
    }
    if (!proposals.length) return source;
    return { ...source, classifications: [...proposals,
      ...(source.classifications ?? []).filter(old => !proposals.some(value => value.source.issueId === old.source.issueId))] };
  }) };
}
