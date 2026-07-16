import {
  CAPABILITY_TABLE,
  type AuthorizationLayer,
} from '../generated/contract.generated.js';

/** Return the schema-owned authorization layer for a capability identifier. */
export function getCapabilityLayer(capability: string): AuthorizationLayer | undefined {
  for (const layer of Object.keys(CAPABILITY_TABLE) as AuthorizationLayer[]) {
    if ((CAPABILITY_TABLE[layer] as readonly string[]).includes(capability)) {
      return layer;
    }
  }
  return undefined;
}
