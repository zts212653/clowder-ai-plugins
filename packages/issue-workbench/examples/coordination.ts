// This example talks only to the isolated Host serving this same origin.
// @ts-ignore built browser entry is supplied by the package build
import { mountCoordination, createCoordinationClient, createTeamClient } from './browser.js';
const legacyUrl = new URLSearchParams(location.search).get('legacy') === '1'
  ? 'http://localhost:5192/settings?s=plugins&issueWorkbenchPreview=1' : undefined;
const request = (path: string, options?: RequestInit) => fetch(path, options);
mountCoordination(document.getElementById('app')!, createCoordinationClient(request, legacyUrl), {
  showClassifications: new URLSearchParams(location.search).get('classifications') === '1',
  team: createTeamClient(request),
});
