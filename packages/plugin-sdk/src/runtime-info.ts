/** Read-only facts about the current Host instance. Paths stay local and are not
 * credentials or permission to scan directories outside the selected project. */
export interface PluginRuntimeInfo {
  readonly version: string;
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly projectRoot: string;
  readonly logDirectory: string;
}

export interface PluginRuntimeInfoHost {
  get(): Promise<PluginRuntimeInfo>;
}

/** A command may open package-owned HTML in the Host's isolated panel. The
 * package must bundle its scripts/styles; the panel has no Host DOM or fetch. */
export interface PluginUiPanel {
  readonly kind: 'plugin-panel';
  readonly version: 1;
  readonly html: string;
}
