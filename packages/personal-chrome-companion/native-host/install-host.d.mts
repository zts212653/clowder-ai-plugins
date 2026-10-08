export const PERSONAL_CHROME_NATIVE_HOST_NAME: 'ai.catcafe.personal_cloud_cat_host';
export interface NativeHostInstallOptions {
  projectRoot: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppData?: string;
  userDataDirectory?: string;
  nodeExecutable?: string;
  sourceDirectory?: string;
}
export interface NativeHostInstallReceipt {
  status: 'ready';
  operation: 'installed' | 'repaired' | 'unchanged' | 'inspect';
  rootDirectory: string;
  pairingRecordPath: string;
  conversationBindingPath: string;
  launcherPath: string;
  manifestPath: string;
  artifactEntrypoint: string;
  extensionId: string;
  artifactDigest: string;
  socketPath: string;
  ledgerPath: string;
  installedAt: string;
  updatedAt: string;
  schemaVersion: 1;
  hasPairingSecret: true;
}
export type NativeHostPairingRecord = Pick<NativeHostInstallReceipt,
  'schemaVersion' | 'extensionId' | 'socketPath' | 'ledgerPath' | 'artifactDigest' | 'installedAt' | 'updatedAt'
> & { pairingSecret: string };
export function installNativeHost(options: NativeHostInstallOptions & {
  extensionId: string;
  now?: () => Date;
  generatePairingSecret?: () => string;
  writePairingRecord?: (path: string, record: NativeHostPairingRecord) => Promise<unknown>;
}): Promise<NativeHostInstallReceipt>;
export function inspectNativeHostInstallation(options: NativeHostInstallOptions): Promise<NativeHostInstallReceipt>;
export function uninstallNativeHost(options: NativeHostInstallOptions & {
  retainAuthorizations?: boolean;
  /** Must be an unreleased acquireInactiveSocketLease fence for this project's socket. */
  socketLease?: { release(): Promise<void> };
}): Promise<{
  status: 'absent'; operation: 'uninstalled'; rootDirectory: string; manifestPath: string;
  pairingRecordPath: string; launcherPath: string; ledgerRetained: boolean; conversationBindingRemoved: boolean;
}>;
export function buildNativeHostInstallPlan(options: {
  platform: NodeJS.Platform; homeDirectory: string; localAppData?: string; userDataDirectory?: string;
  extensionId: string; nativeHostPath: string;
}): { manifestPath: string; manifest: { name: string; description: string; path: string; type: 'stdio'; allowed_origins: string[] }; registryKey?: string };

export function republishNativeHost(options: {
  dataDirectory: string;
  sourceDirectory?: string;
  nodeExecutable?: string;
  now?: () => Date;
  writePairingRecord?: (path: string, record: NativeHostPairingRecord) => Promise<unknown>;
  activate?: (publish: () => Promise<NativeHostRepublishResult>) => Promise<NativeHostRepublishResult>;
}): Promise<{ operation: 'not_installed' | 'unchanged' | 'republished'; artifactDigest?: string }>;
export interface NativeHostRepublishResult {
  operation: 'not_installed' | 'unchanged' | 'republished';
  artifactDigest?: string;
}
