/**
 * Plugin manifest types — v0.1 scope (§3.4, §3.5).
 *
 * v0.1 covers: core identity, features, data classification, runtime.
 * NOT in v0.1 (added as schema deltas in future contract versions):
 * - signals/events → C-2 (v0.2)
 * - tasks/schedule → C-3 (v0.3)
 * - windows → C-2 (v0.2)
 *
 * @packageDocumentation
 */

import type { DataDeclaration } from './data-class.js';

// ---------------------------------------------------------------------------
// Feature & resource model (§3.4)
// ---------------------------------------------------------------------------

/**
 * Reference to a resource within a plugin.
 * Resources are the building blocks; features compose them.
 */
export interface ResourceReference {
  /** Resource type (mcp, skill, limb, schedule, sdk, service, …). */
  readonly type: string;
  /** Resource identifier within this plugin. */
  readonly id: string;
}

/**
 * A user-perceivable capability within a plugin (§3.4).
 *
 * v0: feature is a first-class data structure, but lifecycle engine only
 * supports plugin-level enable/disable.  Feature-level activation comes
 * with voice-suite (first real multi-capability plugin).
 */
export interface PluginFeature {
  readonly id: string;
  readonly name: string;
  readonly resources: readonly ResourceReference[];
  /** Capabilities this feature requires (references capability table). */
  readonly capabilities: readonly string[];
}

// ---------------------------------------------------------------------------
// Runtime declaration (§3.5)
// ---------------------------------------------------------------------------

/** Supported transport mechanisms for plugin ↔ host communication. */
export type RuntimeTransport = 'stdio' | 'ipc' | 'builtin';

/**
 * Runtime configuration declared in the manifest.
 * Carrier is plugin's choice (P7 壳无关).
 */
export interface RuntimeDeclaration {
  /** How the plugin process communicates with the host. */
  readonly transport: RuntimeTransport;
  /**
   * Entry point for the plugin runtime.
   * Interpretation depends on transport (e.g. command for stdio).
   */
  readonly entrypoint?: string;
}

// ---------------------------------------------------------------------------
// Plugin manifest — v0.1 (core + features + data + runtime)
// ---------------------------------------------------------------------------

/**
 * The v0.1 plugin manifest.
 *
 * This is a REQUEST — the host validates it at install time.  Capability
 * grants are separate from declarations.
 *
 * Domain-specific extensions (signals, tasks, windows) are added as schema
 * deltas in C-2 (v0.2) and C-3 (v0.3) — not pre-frozen here.
 */
export interface PluginManifest {
  /** Globally unique plugin identifier. */
  readonly pluginId: string;
  /** Plugin version (semver). */
  readonly version: string;
  /**
   * Contract version this plugin targets.
   * Must be an exact published semver version — no ranges, wildcards,
   * or operator prefixes (five-step freeze: pin exact version).
   */
  readonly contractVersion: string;
  /** Human-readable name. */
  readonly name: string;
  readonly description?: string;

  /**
   * Features — user-perceivable capabilities (§3.4).
   * Data structure is first-class in v0; feature-level lifecycle is future.
   */
  readonly features: readonly PluginFeature[];

  /** Data set declarations with classification and strategy (§3.6). */
  readonly data?: readonly DataDeclaration[];

  /** Runtime configuration (§3.5). */
  readonly runtime: RuntimeDeclaration;
}
