/** Pro may think for tens of minutes. Observation expiry is never a delivery failure. */
export const ASSISTANT_OBSERVATION_TIMEOUT_MS = 60 * 60_000;
export const ASSISTANT_CONTEXT_RETENTION_MS = ASSISTANT_OBSERVATION_TIMEOUT_MS + 60_000;
