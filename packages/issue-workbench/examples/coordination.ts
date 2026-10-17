// This example talks only to the isolated Host serving this same origin.
// @ts-ignore built browser entry is supplied by the package build
import { mountCoordination, createCoordinationClient } from './browser.js';
const legacyUrl = new URLSearchParams(location.search).get('legacy') === '1'
  ? 'http://localhost:5192/settings?s=plugins&issueWorkbenchPreview=1' : undefined;
mountCoordination(document.getElementById('app')!, createCoordinationClient((path: string, options?: RequestInit) => fetch(path, options), legacyUrl), { showClassifications: new URLSearchParams(location.search).get('classifications') === '1' });
