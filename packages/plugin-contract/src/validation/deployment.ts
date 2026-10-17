import { createRequire } from 'node:module';
import type { DeploymentCatalog } from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const validate = new Ajv({ strict: false, allErrors: true }).compile({ $defs: schema.$defs, $ref: '#/$defs/DeploymentCatalog' });
/** A catalog describes deployment metadata, never reviewer authority. */
export function assertDeploymentCatalog(value: unknown): asserts value is DeploymentCatalog {
  if (!validate(value)) throw new TypeError('Invalid DeploymentCatalog');
  const catalog = value as DeploymentCatalog;
  if (!Object.hasOwn(catalog.roster, catalog.defaultCatId)) throw new TypeError('Deployment default cat is absent from roster');
}
