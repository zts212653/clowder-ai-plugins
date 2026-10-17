import { createRoot } from 'react-dom/client';
import { WorkbenchProvider } from './ports/context';
import type { WorkbenchHost } from './ports/host';
import { IssueWorkbenchPreview } from './ui/IssueWorkbenchPreview';
import './theme.css';
import { CoordinationWorkbench } from './ui/CoordinationWorkbench';
import type { CoordinationHost } from './model/issue-coordination';
export type { CoordinationHost } from './model/issue-coordination';
export { createCoordinationClient } from './ports/coordination';
export function mountCoordination(element: HTMLElement, host: CoordinationHost, options: { showClassifications?: boolean } = {}) {
  const root = createRoot(element);
  root.render(<CoordinationWorkbench host={host} showClassifications={options.showClassifications} />);
  return { unmount: () => root.unmount() };
}
export type { WorkbenchHost, ConfirmOptions } from './ports/host';
/** Mount one isolated pre-SDK workbench; the caller owns the supplied Host ports. */
export function mountWorkbench(element: HTMLElement, host: WorkbenchHost): { unmount: () => void } {
  const root = createRoot(element);
  root.render(<WorkbenchProvider host={host}><IssueWorkbenchPreview /></WorkbenchProvider>);
  return { unmount: () => root.unmount() };
}
