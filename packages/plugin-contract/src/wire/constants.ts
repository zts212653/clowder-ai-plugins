/**
 * Wire-protocol framing constants.
 * Every value is mechanized verbatim from the #1165 frozen shape (rev11).
 * This module defines nothing new.
 */

/** Maximum raw UTF-8 bytes per frame, excluding the LF terminator. */
export const MAX_FRAME_BYTES = 1_048_576 as const;

/** The v0 wire protocol version. */
export const WIRE_VERSION = '0.1.0' as const;

/** The contract version this wire shape mechanizes. */
export const CONTRACT_VERSION = '0.1.0' as const;

/** JSON-RPC version constant (exact string). */
export const JSONRPC_VERSION = '2.0' as const;

/**
 * Maximum payload bytes per element payload (frozen x-clowder-bounds).
 * Open-membered payloads (MediaRefElementPayload, RichBlockElementPayload)
 * are bounded by this ceiling alone — no structural narrowing.
 */
export const MAX_ELEMENT_PAYLOAD_BYTES = 65_536 as const;

/**
 * Maximum total payload bytes per message (frozen x-clowder-bounds).
 */
export const MAX_TOTAL_PAYLOAD_BYTES = 262_144 as const;

/**
 * Maximum elements per draft operation (frozen).
 */
export const MAX_ELEMENTS_PER_OPERATION = 32 as const;

/**
 * Maximum elements per message envelope (frozen).
 */
export const MAX_ELEMENTS_PER_MESSAGE = 128 as const;

/**
 * Maximum whisper targets (frozen).
 */
export const MAX_WHISPER_TARGETS = 16 as const;
