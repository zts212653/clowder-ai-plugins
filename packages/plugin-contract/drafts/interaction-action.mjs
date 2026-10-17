// Unpublished F170 first-consumer draft. Host admission, not this parser, grants authority.
const token = /^[a-zA-Z0-9_-]{1,128}$/;
const digest = /^[a-f0-9]{64}$/;
const fields = [
  'v', 'kind', 'sessionHandle', 'bindingGeneration', 'runtimeLease',
  'confirmationHandle', 'actionId', 'objectRef', 'expectedStateToken', 'operationDigest',
];

export function parseInteractionActionDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      Object.keys(value).some((key) => !fields.includes(key)))
    throw new TypeError('interaction action has unknown or missing fields');
  if (value.v !== 0 || value.kind !== 'host-confirmed-action') throw new TypeError('unknown draft action');
  for (const key of fields.slice(2, 8)) if (typeof value[key] !== 'string' || !token.test(value[key]))
    throw new TypeError(`invalid ${key}`);
  for (const key of fields.slice(8)) if (typeof value[key] !== 'string' || !digest.test(value[key]))
    throw new TypeError(`invalid ${key}`);
  return Object.freeze({ ...value });
}
