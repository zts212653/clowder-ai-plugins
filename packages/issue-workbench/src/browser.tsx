import { createRoot } from 'react-dom/client';
import { WorkbenchProvider } from './ports/context';
import type { WorkbenchHost } from './ports/host';
import { IssueWorkbenchPreview } from './ui/IssueWorkbenchPreview';
import './theme.css';
import { CoordinationWorkbench } from './ui/CoordinationWorkbench';
import { TeamWorkbench } from './team-ui/TeamWorkbench';
import type { TeamHost } from './ports/team';
import type { CoordinationHost } from './model/issue-coordination';
export type { CoordinationHost } from './model/issue-coordination';
export { createCoordinationClient } from './ports/coordination';
export { createTeamClient } from './ports/team';
export type { TeamHost } from './ports/team';
/** Real owner-authenticated module operations; no injected coordination bridge. */
export function mountInstalledWorkbench(element: HTMLElement, team: TeamHost) {
  if (!team.coordination) throw new Error('This Host does not expose the installed coordination store');
  return mountCoordination(element, team.coordination, { team });
}
export function mountCoordination(element: HTMLElement, host: CoordinationHost, options: { showClassifications?: boolean; team?: TeamHost } = {}) {
  const root = createRoot(element);
  root.render(options.team ? <TeamWorkbench host={host} team={options.team} showClassifications={options.showClassifications} />
    : <CoordinationWorkbench host={host} showClassifications={options.showClassifications} />);
  return { unmount: () => root.unmount() };
}
export type { WorkbenchHost, ConfirmOptions } from './ports/host';
/** Mount one isolated pre-SDK workbench; the caller owns the supplied Host ports. */
export function mountWorkbench(element: HTMLElement, host: WorkbenchHost): { unmount: () => void } {
  const root = createRoot(element);
  root.render(<WorkbenchProvider host={host}><IssueWorkbenchPreview /></WorkbenchProvider>);
  return { unmount: () => root.unmount() };
}
