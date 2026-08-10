import { createRequire } from 'node:module';

export function larkCliChildEnvironment(homeDirectory: string): NodeJS.ProcessEnv {
  if (homeDirectory.length < 1) throw new TypeError('lark-cli home directory is required');
  return { HOME: homeDirectory };
}

export function resolveBundledLarkCliEntrypoint(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@larksuite/cli/scripts/run.js');
}
