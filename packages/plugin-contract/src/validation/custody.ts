import { createRequire } from 'node:module';
import type * as Contract from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
export interface CustodyContracts {
  CustodyCanonicalizeInput: Contract.CustodyCanonicalizeInput;
  CustodyCanonicalizeResult: Contract.CustodyCanonicalizeResult;
  CustodyPreflightInput: Contract.CustodyPreflightInput;
  CustodyPreflightResult: Contract.CustodyPreflightResult;
  CustodyCompleteInput: Contract.CustodyCompleteInput;
  CustodyCompleteResult: Contract.CustodyCompleteResult;
  PredicateFreshnessInput: Contract.PredicateFreshnessInput;
  PredicateFreshnessResult: Contract.PredicateFreshnessResult;
  PredicateCompletionInput: Contract.PredicateCompletionInput;
  PredicateCompletionResult: Contract.PredicateCompletionResult;
  PredicateProviderBinding: Contract.PredicateProviderBinding;
}
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, (value: unknown) => boolean>();
/** Shared closed wire validation; canonical digests and authority remain Host-owned. */
export function assertCustodyContract<K extends keyof CustodyContracts>(kind: K, value: unknown): asserts value is CustodyContracts[K] {
  let validate = validators.get(kind);
  if (!validate) {
    validate = ajv.compile({ $defs: schema.$defs, $ref: `#/$defs/${kind}` }) as (value: unknown) => boolean;
    validators.set(kind, validate);
  }
  if (!validate(value)) throw new TypeError(`Invalid ${kind}`);
  if (kind === 'PredicateFreshnessInput' || kind === 'PredicateCompletionInput') {
    const input = value as Contract.PredicateFreshnessInput;
    if (input.subjectRef !== input.predicate.subjectRef) throw new TypeError('Predicate subject mismatch');
  }
}
