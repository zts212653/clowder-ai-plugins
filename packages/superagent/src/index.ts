import { validateManifest } from '@clowder-ai/plugin-contract';
import type { PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { startSuperagent } from './runtime.js';

const entrypoint: PluginModuleEntrypoint = {
  create(manifest) {
    const result = validateManifest(manifest);
    if (!result.valid) throw new Error(`Invalid Superagent manifest: ${JSON.stringify(result.errors)}`);
    return {
      start: startSuperagent,
    };
  },
};
export default entrypoint;
