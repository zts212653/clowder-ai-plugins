import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CandidateHello } from '@clowder-ai/plugin-contract';
import { beginLocalHandshake } from '@clowder-ai/plugin-sdk';

export function readRuntimeClaims(env: NodeJS.ProcessEnv): CandidateHello {
  const candidate = {
    pluginId: env.CLOWDER_PLUGIN_ID,
    packageDigest: env.CLOWDER_PACKAGE_DIGEST,
    contractVersion: env.CLOWDER_CONTRACT_VERSION,
    wireVersion: env.CLOWDER_WIRE_VERSION,
  };
  const transition = beginLocalHandshake(candidate);
  if (!transition.accepted) {
    throw new TypeError(`Host runtime claims failed contract validation: ${transition.reason}`);
  }
  return transition.state.candidate;
}

export function meetingIntakeStatePath(
  homeDirectory: string,
  pluginInstanceId: string,
): string {
  if (homeDirectory.length < 1) throw new TypeError('plugin state home directory is required');
  const instanceKey = createHash('sha256').update(pluginInstanceId, 'utf8').digest('hex');
  return join(
    homeDirectory,
    '.clowder-ai',
    'plugin-state',
    'feishu-meeting-intake',
    `${instanceKey}.json`,
  );
}
