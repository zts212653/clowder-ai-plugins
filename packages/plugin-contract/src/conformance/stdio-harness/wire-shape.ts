import type { HarnessChild } from './child-process-harness.js';
import type { DecodedNdjsonFrame, JsonObject } from './ndjson-frame.js';

/**
 * Deliberate seam for the P-1a contract output.
 *
 * This skeleton owns process and frame transport only. The #1165 frozen
 * shape (rev11) is now shape-approved; the wire module mechanizes its
 * 13-row registry, disposition table, and closed error envelopes. This
 * seam will be replaced by a concrete codec backed by those wire types
 * when the handshake rows (1, 2) reach CLOSED leaf closure.
 */
export interface HarnessWireShape<Outbound, Inbound> {
  readonly status: 'shape-approved';
  encode(message: Outbound): JsonObject;
  decode(frame: DecodedNdjsonFrame): Inbound;
  performHelloReady(child: HarnessChild): Promise<void>;
}
