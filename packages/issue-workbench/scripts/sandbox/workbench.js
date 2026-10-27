import { mountCoordination, createCoordinationClient, createTeamClient } from '/assets/browser.js';
const actor = location.pathname.split('/')[1];
if (!['sender', 'receiver'].includes(actor)) throw new Error('Unknown simulated member');
const request = (path, options) => fetch('/' + actor + path, options);
mountCoordination(document.getElementById('app'), createCoordinationClient(request), {
  team: createTeamClient(request),
});
