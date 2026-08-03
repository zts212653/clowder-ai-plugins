#!/usr/bin/env node

import { createStackChanAdapterApp } from './adapter-app.js';
import { resolveStackChanConfigPath } from './cli-options.js';
import { loadStackChanAdapterConfig } from './runtime-config.js';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function runStackChanAdapter(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configPath = resolveStackChanConfigPath(argv, env);
  const config = await loadStackChanAdapterConfig(configPath);
  const app = await createStackChanAdapterApp(config, {
    onError(error) {
      process.stderr.write(`StackChan adapter cycle failed: ${error.message}\n`);
    },
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= app.stop();
    return stopping;
  };
  const onSignal = (): void => {
    void stop().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        process.stderr.write(
          `StackChan adapter shutdown failed: ${describeError(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await app.start();
  } catch (error) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await stop().catch(() => undefined);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStackChanAdapter().catch((error: unknown) => {
    process.stderr.write(
      `StackChan adapter failed to start: ${describeError(error)}\n`,
    );
    process.exitCode = 1;
  });
}
