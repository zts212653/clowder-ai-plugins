import { DATA_CLASS_ALLOWED_STRATEGIES } from '../generated/contract.generated.js';

const STRATEGIES_BY_DATA_CLASS = DATA_CLASS_ALLOWED_STRATEGIES as Readonly<
  Record<string, readonly string[]>
>;

/** Validate a schema-owned (dataClass, strategy) combination. */
export function isValidDataClassStrategy(
  dataClass: unknown,
  strategy: unknown,
): boolean {
  if (typeof dataClass !== 'string' || typeof strategy !== 'string') return false;

  const allowed = STRATEGIES_BY_DATA_CLASS[dataClass];
  if (allowed === undefined) return false;

  return allowed.includes(strategy);
}
