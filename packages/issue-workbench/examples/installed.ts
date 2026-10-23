import { createTeamClient, mountInstalledWorkbench } from './browser.js';

const request = (path: string, options?: RequestInit) => fetch(path, { ...options, credentials: 'same-origin' });
mountInstalledWorkbench(document.getElementById('app')!, createTeamClient(request, '/settings/plugins'));
