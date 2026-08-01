import { isAbsolute } from 'node:path';

export function resolveStackChanConfigPath(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  let value: string | undefined;

  if (argv.length === 0) {
    value = env.STACKCHAN_ADAPTER_CONFIG;
  } else if (argv.length === 2 && argv[0] === '--config') {
    value = argv[1];
  } else {
    throw new Error('Expected exactly --config <absolute-path>');
  }

  if (!value) {
    throw new Error(
      'StackChan adapter config is required via --config or STACKCHAN_ADAPTER_CONFIG',
    );
  }
  if (!isAbsolute(value)) {
    throw new Error('StackChan adapter config path must be absolute');
  }
  return value;
}
