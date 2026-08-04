import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  DISPOSITION_FIXTURE_VECTORS,
  type DispositionFixtureVector,
} from '../../plugin-contract/src/wire/disposition-fixtures.js';
import { MAX_NDJSON_FRAME_BYTES } from '../../plugin-contract/src/conformance/stdio-harness/ndjson-frame.js';

const require = createRequire(new URL('../../plugin-contract/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  addSchema(schema: object, id: string): void;
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
};

const entrypointUrl = new URL('../dist/standalone-host.js', import.meta.url);
const behaviorSchemaUrl = new URL('../../plugin-contract/src/schemas/behavior-fixture.schema.json', import.meta.url);
const manifestSchemaUrl = new URL('../../plugin-contract/src/schemas/manifest.schema.json', import.meta.url);
const hostHalfSeamManifestUrl = new URL('./host-half-seam-manifest.json', import.meta.url);
const lifecycleDeadlineUnixMs = Date.now() + 60_000;

interface ChildResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: Buffer;
}

interface ExpectedChildResult {
  readonly code: number;
  readonly stdout: string;
}

interface HostHalfSeamManifest {
  readonly version: number;
  readonly behaviorFixtures: readonly {
    readonly source: string;
    readonly requires: string;
    readonly caseIds: readonly string[];
  }[];
}

async function runFixtureChild(input: readonly Buffer[]): Promise<ChildResult> {
  const child = spawn(process.execPath, [entrypointUrl.pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on('error', () => undefined);

  for (const chunk of input) child.stdin.write(chunk);
  child.stdin.end();

  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout),
  };
}

function fixtureInput(vector: DispositionFixtureVector): Buffer {
  const body = Buffer.from(vector.rawFrame, vector.rawFrameEncoding);
  return Buffer.concat([body, Buffer.from('\n')]);
}

function expectedForFixture(vector: DispositionFixtureVector): ExpectedChildResult {
  if (vector.expectedOutcome === 'respond') {
    return { code: 0, stdout: `${vector.expectedResponseFrame}\n` };
  }
  return { code: vector.expectedOutcome === 'close' ? 1 : 0, stdout: '' };
}

const executableFixtureVectors = DISPOSITION_FIXTURE_VECTORS.filter(
  vector => vector.preState.inFlightRequests.length === 0,
);
const excludedFixtureVectors = DISPOSITION_FIXTURE_VECTORS.filter(
  vector => vector.preState.inFlightRequests.length > 0,
);

for (const vector of executableFixtureVectors) {
  test(`standalone child enforces ${vector.id}: ${vector.description}`, async () => {
    const result = await runFixtureChild([fixtureInput(vector)]);
    const expected = expectedForFixture(vector);

    assert.equal(result.code, expected.code, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.toString('utf8'), expected.stdout);
  });
}

test('records every pre-state vector as an explicit non-black-box seam', () => {
  assert.deepEqual(
    excludedFixtureVectors.map(vector => ({ id: vector.id, coveredBy: 'S1 unit layer' })),
    [
      { id: 'T-I-1', coveredBy: 'S1 unit layer' },
      { id: 'T-H-2', coveredBy: 'S1 unit layer' },
      { id: 'T-H-5', coveredBy: 'S1 unit layer' },
      { id: 'T-H-9', coveredBy: 'S1 unit layer' },
      { id: 'T-L-1', coveredBy: 'S1 unit layer' },
      { id: 'T-L-2', coveredBy: 'S1 unit layer' },
      { id: 'T-L-3', coveredBy: 'S1 unit layer' },
      { id: 'T-L-4', coveredBy: 'S1 unit layer' },
    ],
    'child-process execution cannot inject in-flight correlation state',
  );
});

const LOCAL_STANDALONE_CASES: readonly {
  readonly id: string;
  readonly input: readonly Buffer[];
  readonly expected: ExpectedChildResult;
}[] = [
  {
    id: 'lifecycle-ping-round-trip',
    input: [
      Buffer.from(
        '{"jsonrpc":"2.0","id":"ping-1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"nonce-1"}}}\n',
        'utf8',
      ),
    ],
    expected: {
      code: 0,
      stdout: '{"jsonrpc":"2.0","id":"ping-1","result":{"nonce":"nonce-1"}}\n',
    },
  },
  {
    id: 'parse-error-recovers-for-next-frame',
    input: [
      Buffer.from(
        '{invalid json\n' +
          '{"jsonrpc":"2.0","id":"ping-1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"nonce-1"}}}\n',
        'utf8',
      ),
    ],
    expected: {
      code: 0,
      stdout:
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n' +
        '{"jsonrpc":"2.0","id":"ping-1","result":{"nonce":"nonce-1"}}\n',
    },
  },
  {
    id: 'lifecycle-drain-round-trip',
    input: [
      Buffer.from(
        `{"jsonrpc":"2.0","id":"drain-1","method":"host.lifecycle.drain","params":{"meta":{"deadlineUnixMs":${lifecycleDeadlineUnixMs}},"input":{"deadlineUnixMs":${lifecycleDeadlineUnixMs}}}}\n`,
        'utf8',
      ),
    ],
    expected: { code: 0, stdout: '{"jsonrpc":"2.0","id":"drain-1","result":null}\n' },
  },
  {
    id: 'reserved-handshake-request-is-rejected',
    input: [
      Buffer.from(
        '{"jsonrpc":"2.0","id":"hello-1","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}\n',
        'utf8',
      ),
    ],
    expected: {
      code: 0,
      stdout: '{"jsonrpc":"2.0","id":"hello-1","error":{"code":-32602,"message":"Invalid params"}}\n',
    },
  },
  {
    id: 'oversize-frame-closes-without-a-response',
    input: [Buffer.concat([Buffer.alloc(MAX_NDJSON_FRAME_BYTES + 1, 0x61), Buffer.from('\n')])],
    expected: { code: 1, stdout: '' },
  },
];

for (const matrixCase of LOCAL_STANDALONE_CASES) {
  test(`standalone child local matrix: ${matrixCase.id}`, async () => {
    const result = await runFixtureChild(matrixCase.input);

    assert.equal(result.code, matrixCase.expected.code, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.toString('utf8'), matrixCase.expected.stdout);
  });
}

test('schema-validates and records every behavior fixture for the K-2 host half', async () => {
  const [manifestSchema, behaviorSchema, seamManifest] = await Promise.all([
    readFile(manifestSchemaUrl, 'utf8').then(text => JSON.parse(text) as { $id: string }),
    readFile(behaviorSchemaUrl, 'utf8').then(text => JSON.parse(text) as object),
    readFile(hostHalfSeamManifestUrl, 'utf8').then(text => JSON.parse(text) as HostHalfSeamManifest),
  ]);
  const [behaviorSeam] = seamManifest.behaviorFixtures;
  assert.ok(behaviorSeam, 'the K-2 host half needs one declared behavior fixture seam');
  const behaviorFixture = JSON.parse(
    await readFile(new URL(behaviorSeam.source, hostHalfSeamManifestUrl), 'utf8'),
  ) as { cases: Array<{ id: string }> };
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(manifestSchema, manifestSchema.$id);
  const validate = ajv.compile(behaviorSchema);

  assert.equal(validate(behaviorFixture), true, JSON.stringify(validate.errors));
  assert.deepEqual(seamManifest, {
    version: 1,
    behaviorFixtures: [
      {
        source: '../../plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json',
        requires: 'K-2 host half',
        caseIds: behaviorFixture.cases.map(behaviorCase => behaviorCase.id),
      },
    ],
  });
});
