import { isDeepStrictEqual } from 'node:util';

export interface OracleTransport<Input, Result, Observation> {
  /** Harness-local control-plane setup; never sent over the plugin wire. */
  setup(): Promise<void>;
  /** The sole semantic operation path being compared across transports. */
  execute(input: Input): Promise<Result>;
  /** Harness-local observation; never exposed as a production wire method. */
  observe(): Promise<Observation>;
}

export interface DualTransportOracleCase<Input> {
  readonly id: string;
  readonly input: Input;
}

export interface TransportTranscript<Result, Observation> {
  readonly before: Observation;
  readonly result: Result;
  readonly after: Observation;
}

export interface DualTransportOracleReport<Result, Observation> {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly inProcess: TransportTranscript<Result, Observation>;
  readonly wire: TransportTranscript<Result, Observation>;
}

async function captureTranscript<Input, Result, Observation>(
  input: Input,
  transport: OracleTransport<Input, Result, Observation>,
): Promise<TransportTranscript<Result, Observation>> {
  await transport.setup();
  const before = structuredClone(await transport.observe());
  const result = structuredClone(await transport.execute(structuredClone(input)));
  const after = structuredClone(await transport.observe());
  return { before, result, after };
}

export async function runDualTransportOracle<Input, Result, Observation>(
  oracleCase: DualTransportOracleCase<Input>,
  inProcessTransport: OracleTransport<Input, Result, Observation>,
  wireTransport: OracleTransport<Input, Result, Observation>,
): Promise<DualTransportOracleReport<Result, Observation>> {
  const [inProcess, wire] = await Promise.all([
    captureTranscript(oracleCase.input, inProcessTransport),
    captureTranscript(oracleCase.input, wireTransport),
  ]);
  const failures: string[] = [];

  if (!isDeepStrictEqual(inProcess.before, wire.before)) {
    failures.push('before observation mismatch');
  }
  if (!isDeepStrictEqual(inProcess.result, wire.result)) {
    failures.push('result mismatch');
  }
  if (!isDeepStrictEqual(inProcess.after, wire.after)) {
    failures.push('after observation mismatch');
  }

  return {
    id: oracleCase.id,
    passed: failures.length === 0,
    failures,
    inProcess,
    wire,
  };
}
