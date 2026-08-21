#!/usr/bin/env node

import { runNativeHost } from './native-host.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'Usage: clowder-personal-chrome-host [--pairing-record /absolute/path.json]\n' +
      'Requires Host-supplied configuration. POSIX only; Windows is unsupported.\n',
  );
} else if (argv.includes('--version')) {
  process.stdout.write('0.1.0-alpha.0\n');
} else {
  runNativeHost({ argv }).catch((error) => {
    process.stderr.write(`personal Chrome native host failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  });
}
