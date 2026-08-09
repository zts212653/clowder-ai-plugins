import {
  HANDSHAKE_REJECT_REASONS,
  validateBrokerReadyParams,
  validateCandidateHello,
  validateSessionBinding,
  type BrokerReadyParams,
  type CandidateHello,
  type HandshakeRejectReason,
  type SessionBinding,
} from '@clowder-ai/plugin-contract';

export type HandshakePhase = 'candidate' | 'bound' | 'activated' | 'rejected';

export interface CandidateHandshakeState {
  readonly phase: 'candidate';
  readonly candidate: CandidateHello;
}

export interface BoundHandshakeState {
  readonly phase: 'bound';
  readonly candidate: CandidateHello;
  readonly binding: SessionBinding;
}

export interface ActivatedHandshakeState {
  readonly phase: 'activated';
  readonly candidate: CandidateHello;
  readonly binding: SessionBinding;
  readonly activation: BrokerReadyParams;
}

export interface RejectedHandshakeState {
  readonly phase: 'rejected';
  readonly reason: HandshakeRejectReason;
}

export type LocalHandshakeState =
  | CandidateHandshakeState
  | BoundHandshakeState
  | ActivatedHandshakeState
  | RejectedHandshakeState;

export interface HandshakeValidationLevels {
  /** All H1–H9 fields use the published beta.8 closed grammar. */
  readonly contractFields: 'full';
}

export interface CandidateHandshakeIntent {
  readonly kind: 'candidate';
  readonly transport: 'local-only';
  readonly candidate: CandidateHello;
  readonly validation: HandshakeValidationLevels;
}

export interface BindingHandshakeIntent {
  readonly kind: 'binding';
  readonly transport: 'local-only';
  readonly binding: SessionBinding;
  readonly validation: HandshakeValidationLevels;
}

export interface ActivationHandshakeIntent {
  readonly kind: 'activation';
  readonly transport: 'local-only';
  readonly ready: BrokerReadyParams;
  readonly validation: HandshakeValidationLevels;
}

/**
 * Objects in this union are deliberately codec-free. They retain the future
 * HarnessWireShape outbound/inbound orientation without constructing wire
 * frames. The published contract now owns the complete beta.8 grammar.
 */
export type LocalHandshakeIntent =
  | CandidateHandshakeIntent
  | BindingHandshakeIntent
  | ActivationHandshakeIntent;

export type LocalHandshakeTransition =
  | {
      readonly accepted: true;
      readonly state: CandidateHandshakeState | BoundHandshakeState | ActivatedHandshakeState;
      readonly intent: LocalHandshakeIntent;
    }
  | {
      readonly accepted: false;
      readonly reason: HandshakeRejectReason;
      readonly state: RejectedHandshakeState;
    };

const HANDSHAKE_REASON_SET = new Set<string>(HANDSHAKE_REJECT_REASONS);
const CLOSED_CONTRACT: HandshakeValidationLevels = {
  contractFields: 'full',
};

function reject(reason: HandshakeRejectReason): LocalHandshakeTransition {
  if (!HANDSHAKE_REASON_SET.has(reason)) {
    throw new RangeError(`unknown handshake rejection reason: ${reason}`);
  }
  return { accepted: false, reason, state: { phase: 'rejected', reason } };
}

function snapshotCandidate(candidate: CandidateHello): CandidateHello {
  return {
    pluginId: candidate.pluginId,
    packageDigest: candidate.packageDigest,
    contractVersion: candidate.contractVersion,
    wireVersion: candidate.wireVersion,
  };
}

function snapshotBinding(binding: SessionBinding): SessionBinding {
  return {
    pluginId: binding.pluginId,
    packageDigest: binding.packageDigest,
    contractVersion: binding.contractVersion,
    wireVersion: binding.wireVersion,
    pluginInstanceId: binding.pluginInstanceId,
    brokerSessionId: binding.brokerSessionId,
    grantRevision: binding.grantRevision,
    effectiveGrants: [...binding.effectiveGrants],
    bindingNonce: binding.bindingNonce,
  };
}

function snapshotReady(ready: BrokerReadyParams): BrokerReadyParams {
  return { bindingNonce: ready.bindingNonce };
}

function isCandidateHello(value: unknown): value is CandidateHello {
  return validateCandidateHello(value);
}

function validateBinding(candidate: CandidateHello, value: unknown):
  | { readonly valid: true; readonly binding: SessionBinding }
  | { readonly valid: false; readonly reason: HandshakeRejectReason } {
  if (!validateSessionBinding(value)) {
    return { valid: false, reason: 'AUTHORITY_VIOLATION' };
  }
  if (value.pluginId !== candidate.pluginId || value.packageDigest !== candidate.packageDigest) {
    return { valid: false, reason: 'PACKAGE_MISMATCH' };
  }
  if (value.contractVersion !== candidate.contractVersion) {
    return { valid: false, reason: 'CONTRACT_INCOMPATIBLE' };
  }
  if (value.wireVersion !== candidate.wireVersion) {
    return { valid: false, reason: 'WIRE_INCOMPATIBLE' };
  }
  return { valid: true, binding: snapshotBinding(value) };
}

function validateReady(value: unknown, binding: SessionBinding): value is BrokerReadyParams {
  return (
    validateBrokerReadyParams(value) &&
    value.bindingNonce === binding.bindingNonce
  );
}

/** Starts a local-only handshake by validating the candidate claims. */
export function beginLocalHandshake(candidate: unknown): LocalHandshakeTransition {
  if (!isCandidateHello(candidate)) {
    return reject('MALFORMED_HELLO');
  }
  const candidateSnapshot = snapshotCandidate(candidate);
  const state: CandidateHandshakeState = { phase: 'candidate', candidate: candidateSnapshot };
  return {
    accepted: true,
    state,
    intent: {
      kind: 'candidate',
      transport: 'local-only',
      candidate: candidateSnapshot,
      validation: CLOSED_CONTRACT,
    },
  };
}

/** Accepts a Host-provided binding only from the local candidate state. */
export function acceptSessionBinding(
  state: LocalHandshakeState,
  binding: unknown,
): LocalHandshakeTransition {
  if (state.phase !== 'candidate') {
    return reject('BINDING_REPLAY');
  }
  const result = validateBinding(state.candidate, binding);
  if (!result.valid) {
    return reject(result.reason);
  }
  const next: BoundHandshakeState = {
    phase: 'bound',
    candidate: state.candidate,
    binding: result.binding,
  };
  return {
    accepted: true,
    state: next,
    intent: {
      kind: 'binding',
      transport: 'local-only',
      binding: result.binding,
      validation: CLOSED_CONTRACT,
    },
  };
}

/** Creates the local activation intent after the binding nonce oracle passes. */
export function prepareActivation(
  state: LocalHandshakeState,
  ready: unknown,
): LocalHandshakeTransition {
  if (state.phase !== 'bound' || !validateReady(ready, state.binding)) {
    return reject('BINDING_REPLAY');
  }
  const readySnapshot = snapshotReady(ready);
  const next: ActivatedHandshakeState = {
    phase: 'activated',
    candidate: state.candidate,
    binding: state.binding,
    activation: readySnapshot,
  };
  return {
    accepted: true,
    state: next,
    intent: {
      kind: 'activation',
      transport: 'local-only',
      ready: readySnapshot,
      validation: CLOSED_CONTRACT,
    },
  };
}
