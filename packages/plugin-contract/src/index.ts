/**
 * @clowder-ai/plugin-contract
 *
 * The single machine-readable truth source for the Clowder AI plugin
 * ecosystem (P15).  Schema, types, capability table, and conformance
 * utilities all ship from this package — the host (clowder-ai) and
 * plugin SDK both consume it; neither redefines structures.
 *
 * ## Version strategy (pre-1.0)
 *
 * - `0.x.0-candidate.N`: work-in-progress, NOT published to registry,
 *   no implementation may consume.
 * - `0.x.0`: published after dual-sign merge (CODEOWNERS) + CI publish.
 *   Registry must show exact version + digest before any gate proceeds.
 * - Breaking changes are expected before 1.0 (P3).
 * - v1.0.0 = public compatibility commitment; breaking window closes.
 *
 * ## Domains (v0.1 candidate)
 *
 * - **messaging**: MessagePayload, MessageDraft, MessageEnvelope,
 *   MessageOutputEvent, AppendElementsRequest, SendReceipt
 * - **manifest**: PluginManifest, PluginFeature, DataDeclaration,
 *   RuntimeDeclaration (v0.1 scope — signals/tasks/windows deferred)
 * - **capability**: L0/L1/L2 capability table (`@signed(G-0 2026-07-15)`)
 * - **data-class**: DataClass × DataStrategy validation
 * - **generated projection**: all public structural types and contract tables
 *   are deterministically generated from the JSON Schemas
 * - **validation**: shared semantic checks for constraints JSON Schema cannot
 *   express, including UTF-8 payload byte budgets
 *
 * @packageDocumentation
 */

// Re-export everything from the types barrel
export * from './types/index.js';
export * from './validation/index.js';

// Wire protocol types, constants, registry, and validators
// Mechanized from #1165 frozen shape (rev11, SHA 7e26e5af…)
export * from './wire/index.js';
