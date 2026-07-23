import { startStdioRuntime } from '@clowder-ai/plugin-sdk';

startStdioRuntime({
  onFrame: frame => ({ type: 'echo', payload: frame }),
});
