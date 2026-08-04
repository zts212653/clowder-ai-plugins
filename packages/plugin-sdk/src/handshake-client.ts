import {
  HANDSHAKE_REJECT_REASONS,
  isWireUInt53,
  validateBindingNonce,
  validateEffectiveGrants,
  validatePackageDigest,
  type BrokerReadyParams,
  type CandidateHello,
  type HandshakeRejectReason,
  type SessionBinding,
} from '@clowder-ai/plugin-contract';

import {
  BROKER_READY_PARAMS_KEYS,
  CANDIDATE_HELLO_KEYS,
  SESSION_BINDING_KEYS,
} from './contract-mirror.js';

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
  /** H1/H3–H6: field presence and primitive type only; grammar remains reserved. */
  readonly reservedFields: 'none' | 'structural';
  /** H2/H7–H9: complete public runtime validation. */
  readonly closedFields: 'full';
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
 * HarnessWireShape outbound/inbound orientation without defining executable
 * broker.hello or broker.ready frames while rows 1–2 remain RESERVED.
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
const STRUCTURAL_AND_CLOSED: HandshakeValidationLevels = {
  reservedFields: 'structural',
  closedFields: 'full',
};
const CLOSED_ONLY: HandshakeValidationLevels = {
  reservedFields: 'none',
  closedFields: 'full',
};

function reject(reason: HandshakeRejectReason): LocalHandshakeTransition {
  if (!HANDSHAKE_REASON_SET.has(reason)) {
    throw new RangeError(`unknown handshake rejection reason: ${reason}`);
  }
  return { accepted: false, reason, state: { phase: 'rejected', reason } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

function isCandidateHello(value: unknown): value is CandidateHello {
  if (!isRecord(value) || !hasExactKeys(value, CANDIDATE_HELLO_KEYS)) return false;
  return (
    typeof value.pluginId === 'string' &&
    typeof value.packageDigest === 'string' &&
    validatePackageDigest(value.packageDigest) &&
    typeof value.contractVersion === 'string' &&
    typeof value.wireVersion === 'string'
  );
}

function validateBinding(candidate: CandidateHello, value: unknown):
  | { readonly valid: true; readonly binding: SessionBinding }
  | { readonly valid: false; readonly reason: HandshakeRejectReason } {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_BINDING_KEYS)) {
    return { valid: false, reason: 'AUTHORITY_VIOLATION' };
  }
  if (
    typeof value.pluginId !== 'string' ||
    typeof value.packageDigest !== 'string' ||
    typeof value.contractVersion !== 'string' ||
    typeof value.wireVersion !== 'string' ||
    typeof value.pluginInstanceId !== 'string' ||
    typeof value.brokerSessionId !== 'string' ||
    typeof value.bindingNonce !== 'string'
  ) {
    return { valid: false, reason: 'AUTHORITY_VIOLATION' };
  }
  if (!validatePackageDigest(value.packageDigest) || value.pluginId !== candidate.pluginId || value.packageDigest !== candidate.packageDigest) {
    return { valid: false, reason: 'PACKAGE_MISMATCH' };
  }
  if (value.contractVersion !== candidate.contractVersion) {
    return { valid: false, reason: 'CONTRACT_INCOMPATIBLE' };
  }
  if (value.wireVersion !== candidate.wireVersion) {
    return { valid: false, reason: 'WIRE_INCOMPATIBLE' };
  }
  if (
    typeof value.grantRevision !== 'number' ||
    !isWireUInt53(value.grantRevision) ||
    !Array.isArray(value.effectiveGrants) ||
    !value.effectiveGrants.every(grant => typeof grant === 'string') ||
    !validateEffectiveGrants(value.effectiveGrants) ||
    !validateBindingNonce(value.bindingNonce)
  ) {
    return { valid: false, reason: 'AUTHORITY_VIOLATION' };
  }
  return { valid: true, binding: value as unknown as SessionBinding };
}

function validateReady(value: unknown, binding: SessionBinding): value is BrokerReadyParams {
  return (
    isRecord(value) &&
    hasExactKeys(value, BROKER_READY_PARAMS_KEYS) &&
    typeof value.bindingNonce === 'string' &&
    validateBindingNonce(value.bindingNonce) &&
    value.bindingNonce === binding.bindingNonce
  );
}

/** Starts a local-only handshake by validating the candidate claims. */
export function beginLocalHandshake(candidate: unknown): LocalHandshakeTransition {
  if (!isCandidateHello(candidate)) {
    return reject('MALFORMED_HELLO');
  }
  const state: CandidateHandshakeState = { phase: 'candidate', candidate };
  return {
    accepted: true,
    state,
    intent: {
      kind: 'candidate',
      transport: 'local-only',
      candidate,
      validation: STRUCTURAL_AND_CLOSED,
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
      validation: STRUCTURAL_AND_CLOSED,
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
  const next: ActivatedHandshakeState = {
    phase: 'activated',
    candidate: state.candidate,
    binding: state.binding,
    activation: ready,
  };
  return {
    accepted: true,
    state: next,
    intent: {
      kind: 'activation',
      transport: 'local-only',
      ready,
      validation: CLOSED_ONLY,
    },
  };
}
