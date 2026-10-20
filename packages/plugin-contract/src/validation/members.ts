import { createRequire } from 'node:module';
import type { PluginMember } from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const member = new Ajv({ strict: false, allErrors: true }).compile({ $defs: schema.$defs, $ref: '#/$defs/PluginMember' });
/** Public registry data only. Availability is quota information, never invocation permission. */
export function assertPluginMember(value: unknown): asserts value is PluginMember {
  if (!member(value) || !(value as PluginMember).catId.trim()) throw new TypeError('Invalid PluginMember');
}
