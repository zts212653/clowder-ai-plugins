import type {
  BehaviorCase,
  ConfigurationField,
  DataDeclaration,
  ExpectedVerdict,
  M0CAckInput,
  M0CSubscribeInput,
  MessagingErrorCode,
  PackageIcon,
  RuntimeDeclaration,
  SideEffectAssertion,
} from './contract.generated.js';
import {
  M0CACK_INPUT_KEYS,
  M0CSUBSCRIBE_INPUT_KEYS,
  MESSAGING_ERROR_CODE_VALUES,
} from './contract.generated.js';

// Generated runtime key sets must name exactly the fields of the generated
// type they mirror (compile-time guard against generator regressions).
type ExactKeys<T, K extends string> =
  [keyof T & string] extends [K] ? [K] extends [keyof T & string] ? true : false : false;

const _subscribeInputKeys: ExactKeys<
  M0CSubscribeInput,
  (typeof M0CSUBSCRIBE_INPUT_KEYS)[number]
> = true;
const _ackInputKeys: ExactKeys<M0CAckInput, (typeof M0CACK_INPUT_KEYS)[number]> = true;

// Generated enum values must be identical to the MessagingErrorCode union.
type ExactStringUnion<A, B> =
  [A] extends [B] ? [B] extends [A] ? true : false : false;
const _messagingErrorCodeValues: ExactStringUnion<
  MessagingErrorCode,
  (typeof MESSAGING_ERROR_CODE_VALUES)[number]
> = true;

void [_subscribeInputKeys, _ackInputKeys, _messagingErrorCodeValues];

const lifecycleCache: DataDeclaration = {
  name: 'compiled-cache',
  dataClass: 'cache',
  strategy: 'lifecycle',
};

const retainedUserData: DataDeclaration = {
  name: 'user-notes',
  dataClass: 'user-authored',
  strategy: 'retained',
};

// @ts-expect-error user-authored data cannot be lifecycle-scoped.
const invalidLifecycleUserData: DataDeclaration = {
  name: 'unsafe-user-notes',
  dataClass: 'user-authored',
  strategy: 'lifecycle',
};

const builtinRuntime: RuntimeDeclaration = {
  transport: 'builtin',
};

const externalRuntime: RuntimeDeclaration = {
  transport: 'stdio',
  entrypoint: 'dist/plugin.js',
};

// @ts-expect-error external runtimes require a launch entrypoint.
const invalidExternalRuntime: RuntimeDeclaration = {
  transport: 'ipc',
};

const selectField: ConfigurationField = {
  key: 'provider',
  label: 'Provider',
  kind: 'select',
  required: true,
  options: [{ value: 'gemini', label: 'Gemini' }],
  default: 'gemini',
};

const booleanField: ConfigurationField = {
  key: 'enabled',
  label: 'Enabled',
  kind: 'boolean',
  required: false,
  default: true,
};

const svgIcon: PackageIcon = {
  type: 'svg',
  src: 'assets/icon.svg',
};

// @ts-expect-error icon type and filename suffix must agree.
const invalidSvgIcon: PackageIcon = { type: 'svg', src: 'assets/icon.png' };

// @ts-expect-error select configuration fields require options.
const invalidSelectWithoutOptions: ConfigurationField = { key: 'provider', label: 'Provider', kind: 'select', required: true };

// @ts-expect-error non-select configuration fields forbid options.
const invalidStringWithOptions: ConfigurationField = { key: 'model', label: 'Model', kind: 'string', required: false, options: [{ value: 'flash', label: 'Flash' }] };

// @ts-expect-error secret configuration fields forbid defaults.
const invalidSecretDefault: ConfigurationField = { key: 'api-key', label: 'API key', kind: 'secret', required: true, default: 'secret' };

// @ts-expect-error boolean configuration fields require boolean defaults.
const invalidBooleanDefault: ConfigurationField = { key: 'enabled', label: 'Enabled', kind: 'boolean', required: false, default: 'yes' };

const valueBearingAssertion: SideEffectAssertion = {
  target: 'messages',
  assertion: 'state_equals',
  value: [],
};

const valuelessAssertion: SideEffectAssertion = {
  target: 'messages',
  assertion: 'unchanged',
};

// @ts-expect-error value-bearing assertions require value.
const invalidValueBearingAssertion: SideEffectAssertion = { target: 'messages', assertion: 'matches' };

// @ts-expect-error valueless assertions forbid value.
const invalidValuelessAssertion: SideEffectAssertion = { target: 'messages', assertion: 'none', value: [] };

const successVerdict: ExpectedVerdict = {
  status: 'success',
  sideEffects: [valuelessAssertion],
};

const errorVerdict: ExpectedVerdict = {
  status: 'error',
  errorCode: 'VALIDATION',
  sideEffects: [valuelessAssertion],
};

// @ts-expect-error error verdicts require errorCode.
const invalidErrorVerdict: ExpectedVerdict = { status: 'error', sideEffects: [valuelessAssertion] };

// @ts-expect-error success verdicts forbid errorCode.
const invalidSuccessVerdict: ExpectedVerdict = { status: 'success', errorCode: 'VALIDATION', sideEffects: [valuelessAssertion] };

declare const behaviorCaseBase: Pick<BehaviorCase, 'id' | 'invariant' | 'given' | 'expect'>;

const sendBehaviorCase: BehaviorCase = {
  ...behaviorCaseBase,
  when: {
    operation: 'send',
    input: { address: {}, idempotencyKey: 'send-1', payload: {} },
  },
  execution: {
    plane: 'plugin-to-host-wire',
    method: 'messaging.send',
    verdictOracle: { kind: 'behavior-expectation' },
  },
};

// @ts-expect-error send behavior cases must execute messaging.send.
const invalidSendBehaviorCase: BehaviorCase = { ...behaviorCaseBase, when: { operation: 'send', input: { address: {}, idempotencyKey: 'send-1', payload: {} } }, execution: { plane: 'plugin-to-host-wire', method: 'messaging.read', verdictOracle: { kind: 'behavior-expectation' } } };

void [
  lifecycleCache,
  retainedUserData,
  invalidLifecycleUserData,
  builtinRuntime,
  externalRuntime,
  invalidExternalRuntime,
  selectField,
  booleanField,
  svgIcon,
  invalidSvgIcon,
  invalidSelectWithoutOptions,
  invalidStringWithOptions,
  invalidSecretDefault,
  invalidBooleanDefault,
  valueBearingAssertion,
  valuelessAssertion,
  invalidValueBearingAssertion,
  invalidValuelessAssertion,
  successVerdict,
  errorVerdict,
  invalidErrorVerdict,
  invalidSuccessVerdict,
  sendBehaviorCase,
  invalidSendBehaviorCase,
];
