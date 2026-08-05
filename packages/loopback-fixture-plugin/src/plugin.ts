import {
  loadStandaloneManifest,
  startStdioRuntime,
} from '@clowder-ai/plugin-sdk';

await loadStandaloneManifest(new URL('../manifest.json', import.meta.url));

startStdioRuntime({
  onFrame: frame => ({ type: 'echo', payload: frame.value }),
});
