import { createRequire } from 'node:module';
import type { PluginOwnerThread, PluginOwnerThreadCreateInput, PluginOwnerThreadAddParticipantsInput } from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const ajv = new Ajv({ strict: false, allErrors: true });
const thread = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginOwnerThread' });
const create = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginOwnerThreadCreateInput' });
const add = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginOwnerThreadAddParticipantsInput' });

// Host limits use JavaScript UTF-16 length and trim(), rather than JSON Schema
// Unicode character counts or a regular expression's final-newline boundary.
function bounded(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && value.trim() === value;
}

/** Data validation only; strict owner identity, known cats and currentness remain Host-owned. */
export function assertPluginOwnerThread(value: unknown): asserts value is PluginOwnerThread {
  if (!thread(value) || !bounded((value as PluginOwnerThread).id, 500)) throw new TypeError('Invalid PluginOwnerThread');
}

export function assertPluginOwnerThreadCreateInput(value: unknown): asserts value is PluginOwnerThreadCreateInput {
  if (!create(value) || !bounded((value as PluginOwnerThreadCreateInput).title, 200)) throw new TypeError('Invalid PluginOwnerThreadCreateInput');
}

export function assertPluginOwnerThreadAddParticipantsInput(value: unknown): asserts value is PluginOwnerThreadAddParticipantsInput {
  if (!add(value) || !bounded((value as PluginOwnerThreadAddParticipantsInput).threadId, 500)) throw new TypeError('Invalid PluginOwnerThreadAddParticipantsInput');
}
