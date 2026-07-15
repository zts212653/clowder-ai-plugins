/**
 * Conformance utilities — re-exported for programmatic use.
 *
 * The primary entry point is the runner CLI (runner.ts).
 * This module exports validation helpers that the host and SDK can use
 * to validate manifests and messages against the contract schemas.
 *
 * @packageDocumentation
 */

export {
  DATA_CLASS_ALLOWED_STRATEGIES,
  isValidDataClassStrategy,
} from '../types/data-class.js';

export {
  CAPABILITY_TABLE,
  getCapabilityLayer,
  L0_CAPABILITIES,
  L1_CAPABILITIES,
  L2_CAPABILITIES,
} from '../types/capability.js';
