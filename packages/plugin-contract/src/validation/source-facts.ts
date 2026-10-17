import { createRequire } from 'node:module';
import type { PluginSourceFact, PluginSourceFactsReadInput, PluginNativeContext, PluginNativeTaskContext,
  PluginNativeTaskContextInput, PluginTaskAdmissionInput, PluginTaskAdmissionResult,
  PluginTaskDispatchInput, PluginTaskDispatchResult } from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const ajv = new Ajv({ strict: false, allErrors: true });
// The approved Host admission schema uses Zod's UTF-16 string limits. JSON Schema
// maxLength counts Unicode code points, so this schema annotation preserves both.
ajv.addKeyword({ keyword: 'x-clowder-max-utf16-units', schemaType: 'number', type: 'string',
  validate: (limit: number, value: string) => value.length <= limit });
const fact = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginSourceFact' });
const input = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginSourceFactsReadInput' });
const context = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginNativeContext' });
const taskContext = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginNativeTaskContext' });
const taskContextInput = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginNativeTaskContextInput' });
const taskAdmissionInput = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginTaskAdmissionInput' });
const taskAdmissionResult = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginTaskAdmissionResult' });
const taskDispatchInput = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginTaskDispatchInput' });
const taskDispatchResult = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginTaskDispatchResult' });

// Mirrors the Host protocol data boundary. Inspect descriptors before validators read any values.
function plainData(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor?.enumerable === true && 'value' in descriptor && plainData(descriptor.value, depth + 1);
  });
}
export function assertPluginSourceFact(value: unknown): asserts value is PluginSourceFact {
  if (!plainData(value) || !fact(value)) throw new TypeError('Invalid PluginSourceFact');
}
export function assertPluginNativeContext(value: unknown): asserts value is PluginNativeContext {
  // Host wraps an already-snapshotted source fact; the identity wrapper does not consume its depth budget.
  if (!plainData(value, -1) || !context(value)) throw new TypeError('Invalid PluginNativeContext');
}
export function assertPluginNativeTaskContextInput(value: unknown): asserts value is PluginNativeTaskContextInput {
  if (!plainData(value) || !taskContextInput(value)) throw new TypeError('Invalid PluginNativeTaskContextInput');
}
export function assertPluginNativeTaskContext(value: unknown): asserts value is PluginNativeTaskContext {
  if (!plainData(value, -1) || !taskContext(value)) throw new TypeError('Invalid PluginNativeTaskContext');
  const fact = value as PluginNativeTaskContext;
  // The Host authenticates both threads. They may differ; the source owner must not.
  if (fact.source.userId !== fact.userId || fact.source.catId !== null ||
    ![fact.userId, fact.threadId, fact.catId, fact.invocationId, fact.originTriggerMessageId].every(v => v.length > 0))
    throw new TypeError('Invalid PluginNativeTaskContext identity');
}
export function capturePluginTaskAdmissionInput(value: unknown): PluginTaskAdmissionInput {
  if (!plainData(value)) throw new TypeError('Invalid PluginTaskAdmissionInput');
  // Match the approved Host Zod trim semantics; discriminator literals are exact.
  const trim = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key === 'kind' ? v : v.trim();
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(item => trim(item));
    return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, trim(item, k)]));
  };
  const captured = trim(structuredClone(value));
  if (!taskAdmissionInput(captured)) throw new TypeError('Invalid PluginTaskAdmissionInput');
  return captured as PluginTaskAdmissionInput;
}
export function assertPluginTaskAdmissionResult(value: unknown): asserts value is PluginTaskAdmissionResult {
  if (!plainData(value) || !taskAdmissionResult(value)) throw new TypeError('Invalid PluginTaskAdmissionResult');
}
export function assertPluginTaskDispatchInput(value: unknown): asserts value is PluginTaskDispatchInput {
  if (!plainData(value) || !taskDispatchInput(value)) throw new TypeError('Invalid PluginTaskDispatchInput');
}
export function assertPluginTaskDispatchResult(value: unknown): asserts value is PluginTaskDispatchResult {
  if (!plainData(value) || !taskDispatchResult(value)) throw new TypeError('Invalid PluginTaskDispatchResult');
}
export function assertPluginSourceFactsReadInput(value: unknown): asserts value is PluginSourceFactsReadInput {
  if (!plainData(value) || !input(value)) throw new TypeError('Invalid PluginSourceFactsReadInput');
  const ref = (value as PluginSourceFactsReadInput).messageRef;
  if ([...ref].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError('Invalid PluginSourceFactsReadInput');
  }
}
