import type { HarnessChild } from './child-process-harness.js';
import type { DecodedNdjsonFrame, JsonObject } from './ndjson-frame.js';

/**
 * Deliberate seam for the P-1a contract output.
 *
 * This skeleton owns process and frame transport only. It does not invent the
 * CandidateHello/broker.ready sequence or any method schema while #1165 is
 * pending. P-1a supplies the concrete codec and two-step handshake later.
 */
export interface HarnessWireShape<Outbound, Inbound> {
  readonly status: 'pending-shape-approved';
  encode(message: Outbound): JsonObject;
  decode(frame: DecodedNdjsonFrame): Inbound;
  performHelloReady(child: HarnessChild): Promise<void>;
}
