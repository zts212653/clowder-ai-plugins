import {
  loadStandaloneManifest,
  startStandaloneHost,
} from '@clowder-ai/plugin-sdk';

startStandaloneHost({
  manifest: await loadStandaloneManifest(new URL('../manifest.json', import.meta.url)),
  onMessage: () => ({ accepted: true }),
});
