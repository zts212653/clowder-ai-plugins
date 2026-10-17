import { assertPluginParticipant, assertPluginParticipantWithAvailability, assertPluginParticipantRosterInput,
  type PluginParticipant, type PluginParticipantWithAvailability, type PluginParticipantRosterInput } from '@clowder-ai/plugin-contract';
export type { PluginParticipant, PluginParticipantWithAvailability, PluginParticipantRosterInput } from '@clowder-ai/plugin-contract';

/** Current authenticated owner or same-owner verified native invocation only.
 * Host derives instance/method scope from the admitted contribution, never input authority.
 * Older Host carriers may refuse opt-in; response validation never substitutes native support for quota. */
export interface PluginParticipantRosterHost {
  listForNativeContribution(input: PluginParticipantRosterInput): Promise<readonly (PluginParticipant | PluginParticipantWithAvailability)[]>;
}
export interface PluginParticipantRosterClient {
  listForNativeContribution(input: PluginParticipantRosterInput & { readonly includeAvailability: true }): Promise<readonly PluginParticipantWithAvailability[]>;
  listForNativeContribution(input: PluginParticipantRosterInput): Promise<readonly PluginParticipant[]>;
}
export function createParticipantRosterClient(host: PluginParticipantRosterHost, assertActive: () => void): PluginParticipantRosterClient {
  if (!host || typeof host.listForNativeContribution !== 'function') throw new TypeError('Host participant roster port requires listForNativeContribution');
  function read(input: PluginParticipantRosterInput & { readonly includeAvailability: true }): Promise<readonly PluginParticipantWithAvailability[]>;
  function read(input: PluginParticipantRosterInput): Promise<readonly PluginParticipant[]>;
  async function read(input: PluginParticipantRosterInput): Promise<readonly (PluginParticipant | PluginParticipantWithAvailability)[]> {
    assertActive();
    assertPluginParticipantRosterInput(input);
    const includeAvailability = Object.hasOwn(input, 'includeAvailability') && input.includeAvailability === true;
    const result = await host.listForNativeContribution(Object.freeze({ contributionId: input.contributionId,
      ...(includeAvailability ? { includeAvailability: true as const } : {}) }));
    assertActive();
    if (!Array.isArray(result)) throw new TypeError('Invalid PluginParticipant roster');
    const publicRow = (value: PluginParticipant) => ({
      catId: value.catId, displayName: value.displayName, defaultModel: value.defaultModel, supported: value.supported,
      ...(value.nickname === undefined ? {} : { nickname: value.nickname }),
      ...(value.variantLabel === undefined ? {} : { variantLabel: value.variantLabel }),
      ...(value.roleDescription === undefined ? {} : { roleDescription: value.roleDescription }),
      ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
    });
    return Object.freeze(result.map(value => {
      if (includeAvailability) {
        assertPluginParticipantWithAvailability(value);
        return Object.freeze({ ...publicRow(value), available: value.available });
      }
      assertPluginParticipant(value);
      return Object.freeze(publicRow(value));
    }));
  }
  return Object.freeze({ listForNativeContribution: read });
}
