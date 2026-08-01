import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  addSchema(schema: object, id: string): void;
  getSchema(ref: string): ((data: unknown) => boolean) | undefined;
};
const addFormats = require('ajv-formats') as (ajv: object) => void;

const schema = JSON.parse(
  readFileSync(new URL('../schemas/physical-limb.schema.json', import.meta.url), 'utf8'),
) as {
  $id: string;
  'x-clowder-physical-limb-grants'?: string[];
  'x-clowder-physical-limb-bounds'?: Record<string, number>;
};
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema, schema.$id);

function validate(definition: string, value: unknown): boolean {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  assert.ok(validator, `missing schema definition ${definition}`);
  return validator(value);
}

function makeContribution(): Record<string, unknown> {
  return {
    contributionId: 'stackchan-body',
    nodeType: 'stackchan',
    displayName: 'StackChan',
    grants: [
      'limb.action.motion',
      'limb.action.display',
      'limb.action.light',
      'limb.action.speaker',
      'limb.observe.touch',
      'limb.sensor.microphone',
    ],
    safePose: {
      yawDeg: 0,
      pitchDeg: 10,
      timeoutMs: 1500,
    },
  };
}

function makeTouchObservation(): Record<string, unknown> {
  return {
    v: 1,
    observationId: 'touch-session-1-100',
    nodeId: 'stackchan-living-room',
    occurredAt: '2026-08-01T09:10:00Z',
    sessionId: 'device-session-1',
    kind: 'touch',
    payload: {
      gesture: 'stroke',
      durationMs: 812,
      confidence: 1,
    },
  };
}

function makeTranscriptObservation(): Record<string, unknown> {
  return {
    v: 1,
    observationId: 'listen-session-1',
    nodeId: 'stackchan-living-room',
    occurredAt: '2026-08-01T09:10:05Z',
    sessionId: 'device-session-1',
    kind: 'transcript',
    payload: {
      interactionId: 'touch-session-1-100',
      text: '砚砚，你能听见我吗？',
      language: 'zh',
      captureDurationMs: 5000,
    },
  };
}

test('physical limb grants remain independently authorizable', () => {
  assert.deepEqual(schema['x-clowder-physical-limb-grants'], [
    'limb.action.motion',
    'limb.action.display',
    'limb.action.light',
    'limb.action.speaker',
    'limb.observe.touch',
    'limb.sensor.microphone',
    'limb.sensor.camera',
  ]);
  assert.equal(validate('PhysicalLimbContribution', makeContribution()), true);

  const unknownGrant = makeContribution();
  unknownGrant['grants'] = ['limb.everything'];
  assert.equal(validate('PhysicalLimbContribution', unknownGrant), false);
});

test('typed touch and bounded transcript observations are admitted', () => {
  assert.equal(validate('PhysicalLimbObservation', makeTouchObservation()), true);
  assert.equal(validate('PhysicalLimbObservation', makeTranscriptObservation()), true);
});

test('raw sensor payloads and cross-kind fields are structurally rejected', () => {
  const rawAudio = makeTranscriptObservation();
  (rawAudio['payload'] as Record<string, unknown>)['rawAudio'] = 'base64-secret';
  assert.equal(validate('PhysicalLimbObservation', rawAudio), false);

  const touchWithText = makeTouchObservation();
  (touchWithText['payload'] as Record<string, unknown>)['text'] = 'fabricated intent';
  assert.equal(validate('PhysicalLimbObservation', touchWithText), false);
});

test('observation identifiers, durations, and transcript text are bounded', () => {
  assert.deepEqual(schema['x-clowder-physical-limb-bounds'], {
    maxIdentifierLength: 128,
    maxTranscriptCodePoints: 4096,
    maxTouchDurationMs: 10000,
    minListenDurationMs: 100,
    maxListenDurationMs: 30000,
    maxActionTimeoutMs: 30000,
  });

  const tooLong = makeTranscriptObservation();
  (tooLong['payload'] as Record<string, unknown>)['text'] = '猫'.repeat(4097);
  assert.equal(validate('PhysicalLimbObservation', tooLong), false);

  const tooLongTouch = makeTouchObservation();
  (tooLongTouch['payload'] as Record<string, unknown>)['durationMs'] = 10001;
  assert.equal(validate('PhysicalLimbObservation', tooLongTouch), false);
});

test('actions require deadline, cancellation, provenance, and safe bounds', () => {
  const motion = {
    v: 1,
    actionId: 'action-1',
    nodeId: 'stackchan-living-room',
    deadlineUnixMs: 1785575419880,
    timeoutMs: 1500,
    cancelToken: 'cancel-action-1',
    kind: 'motion',
    payload: {
      yawDeg: 0,
      pitchDeg: 35,
      speedDps: 120,
      accelerationDps2: 240,
    },
  };
  assert.equal(validate('PhysicalLimbAction', motion), true);

  assert.equal(
    validate('PhysicalLimbAction', {
      ...motion,
      payload: { ...motion.payload, pitchDeg: 91 },
    }),
    false,
  );
  assert.equal(
    validate('PhysicalLimbAction', {
      ...motion,
      payload: { ...motion.payload, speedDps: 241 },
    }),
    false,
  );

  const display = {
    v: 1,
    actionId: 'action-2',
    nodeId: 'stackchan-living-room',
    deadlineUnixMs: 1785575419880,
    timeoutMs: 1500,
    cancelToken: 'cancel-action-2',
    kind: 'display',
    payload: {
      expression: 'listening',
      expressionSource: { kind: 'cat_state', ref: 'state-123' },
    },
  };
  assert.equal(validate('PhysicalLimbAction', display), true);

  const noProvenance = structuredClone(display);
  delete (noProvenance.payload as Record<string, unknown>)['expressionSource'];
  assert.equal(validate('PhysicalLimbAction', noProvenance), false);

  const noCancellation = structuredClone(motion);
  delete (noCancellation as Record<string, unknown>)['cancelToken'];
  assert.equal(validate('PhysicalLimbAction', noCancellation), false);
});

test('speaker volume and readiness reasons are closed and bounded', () => {
  const speaker = {
    v: 1,
    actionId: 'action-3',
    nodeId: 'stackchan-living-room',
    deadlineUnixMs: 1785575419880,
    timeoutMs: 5000,
    cancelToken: 'cancel-action-3',
    kind: 'speaker',
    payload: {
      text: '我听见啦。',
      voiceProfileRef: 'voice:yanyan',
      volumePercent: 60,
    },
  };
  assert.equal(validate('PhysicalLimbAction', speaker), true);
  assert.equal(
    validate('PhysicalLimbAction', {
      ...speaker,
      payload: { ...speaker.payload, volumePercent: 101 },
    }),
    false,
  );

  assert.equal(
    validate('PhysicalLimbReadiness', {
      v: 1,
      nodeId: 'stackchan-living-room',
      status: 'degraded',
      reason: 'speech_dependency_missing',
      observedAt: '2026-08-01T09:10:00Z',
    }),
    true,
  );
  assert.equal(
    validate('PhysicalLimbReadiness', {
      v: 1,
      nodeId: 'stackchan-living-room',
      status: 'degraded',
      reason: 'whatever-the-plugin-says',
      observedAt: '2026-08-01T09:10:00Z',
    }),
    false,
  );
  assert.equal(
    validate('PhysicalLimbReadiness', {
      v: 1,
      nodeId: 'stackchan-living-room',
      status: 'degraded',
      observedAt: '2026-08-01T09:10:00Z',
    }),
    false,
  );
  assert.equal(
    validate('PhysicalLimbReadiness', {
      v: 1,
      nodeId: 'stackchan-living-room',
      status: 'ready',
      reason: 'device_disconnected',
      observedAt: '2026-08-01T09:10:00Z',
    }),
    false,
  );
});
