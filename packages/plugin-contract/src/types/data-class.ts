import {
  DATA_CLASS_ALLOWED_STRATEGIES,
  type DataClass,
  type DataStrategy,
} from '../generated/contract.generated.js';

/** Validate a schema-owned (dataClass, strategy) combination. */
export function isValidDataClassStrategy(
  dataClass: DataClass,
  strategy: DataStrategy,
): boolean {
  const allowed = DATA_CLASS_ALLOWED_STRATEGIES[dataClass] as readonly DataStrategy[];
  return allowed.includes(strategy);
}
