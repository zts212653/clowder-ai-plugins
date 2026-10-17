import { createRequire } from 'node:module';
import type * as Contract from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
export interface FrustrationContracts {
  FrustrationSourceId: Contract.FrustrationSourceId;
  FrustrationSource: Contract.FrustrationSource;
  FrustrationLinkDraftInput: Contract.FrustrationLinkDraftInput;
  FrustrationLinkDraftResult: Contract.FrustrationLinkDraftResult;
}
const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: true });
const validators = new Map<string, (value: unknown) => boolean>();
export function assertFrustrationContract<K extends keyof FrustrationContracts>(kind: K, value: unknown): asserts value is FrustrationContracts[K] {
  let validate = validators.get(kind);
  if (!validate) {
    validate = ajv.compile({ $defs: schema.$defs, $ref: `#/$defs/${kind}` }) as (value: unknown) => boolean;
    validators.set(kind, validate);
  }
  if (!validate(value)) throw new TypeError(`Invalid ${kind}`);
}
