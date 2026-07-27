import { startStdioRuntime } from '@clowder-ai/plugin-sdk';

startStdioRuntime({
  onFrame: frame => ({ type: 'echo', payload: frame.value }),
});

if (process.env.STDIO_RUNTIME_TEST_READY === '1') {
  process.stderr.write('ready\n');
}
