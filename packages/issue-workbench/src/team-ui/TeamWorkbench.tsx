import { useCallback, useMemo, useState } from 'react';
import type { CoordinationHost, CoordinationSnapshot } from '../model/issue-coordination.js';
import type { TeamHost, TeamSummary } from '../ports/team.js';
import type { TeamClassification } from '../team/records.js';
import { CoordinationWorkbench } from '../ui/CoordinationWorkbench';
import { AssignmentBatchEntry } from './AssignmentBatchBoard';
import { TeamDrawer } from './TeamDrawer';
import { TeamIssuePanel } from './TeamIssuePanel';
import { withTeamClassifications } from './classification-overlay';
import { withTeamClaims } from './claim-overlay';
import type { TeamIssue } from '../team/types.js';

export function TeamWorkbench({ host, team, showClassifications }: {
  host: CoordinationHost; team: TeamHost; showClassifications?: boolean;
}) {
  const [classifications, setClassifications] = useState<TeamClassification[]>([]);
  const [currentIssues, setCurrentIssues] = useState<TeamIssue[]>([]);
  const integratedHost = useMemo<CoordinationHost>(() => ({ ...host, load: async refresh => {
    const snapshot = await host.load(refresh);
    setCurrentIssues([]);
    try { setClassifications((await team.summary()).classifications ?? []); }
    catch { setClassifications([]); } // READ work remains available when the team module is disconnected.
    return snapshot;
  } }), [host, team]);
  const onRead = useCallback((summary?: TeamSummary) => {
    if (!summary?.issueContext) { setClassifications([]); setCurrentIssues([]); return; }
    const issue = summary.issueContext.currentIssue;
    setCurrentIssues(previous => [...previous.filter(value => value.repo !== issue.repo || value.number !== issue.number), issue]);
    setClassifications(previous => [...previous.filter(value => value.issue.repo !== issue.repo || value.issue.number !== issue.number),
      ...(summary.classifications ?? [])]);
  }, []);
  const projectSnapshot = useCallback((snapshot: CoordinationSnapshot) => withTeamClaims(withTeamClassifications(snapshot, classifications), currentIssues), [classifications, currentIssues]);
  return <CoordinationWorkbench host={integratedHost} showClassifications={showClassifications} projectSnapshot={projectSnapshot}
    tools={<><AssignmentBatchEntry host={team} /><TeamDrawer host={team} /></>}
    issueTools={(profile, fact, category, workRevision, dirty) => <TeamIssuePanel key={`${profile.id}:${fact.id}`} host={team} profile={profile} fact={fact} category={category} workRevision={workRevision} dirty={dirty} onRead={onRead} />} />;
}
