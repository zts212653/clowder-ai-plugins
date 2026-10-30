export interface Storage {
  get(key: string): Promise<{ revision: number; value: unknown } | undefined>;
  compareAndSet(key: string, expected: number | null, value: unknown): Promise<{ applied: boolean; revision?: number }>;
}
export interface OwnerContext {
  kind: 'owner-http-request'; userId: string; pluginInstanceId: string; operation: 'read' | 'write';
  requestIdentity?: { requestId: string }; signal: AbortSignal; assertCurrent(): Promise<void>;
}
/** Versioned optional Host seam. Older Hosts fail closed while direct/manual feedback remains usable. */
export interface Host {
  pluginInstanceId: string; dataPath: string; storage: Storage;
  config: { get(key: string): Promise<unknown> }; secrets: { get(key: string): Promise<string | undefined> };
  runtimeInfo?: import('@clowder-ai/plugin-sdk').PluginRuntimeInfoHost;
  members?: import('@clowder-ai/plugin-sdk').ModulePluginHostShape['members'];
  threads?: Pick<import('@clowder-ai/plugin-sdk').PluginThreadHost, 'create' | 'get' | 'list'> & Partial<Pick<import('@clowder-ai/plugin-sdk').PluginThreadHost, 'readMessages'>>;
  messaging?: Pick<import('@clowder-ai/plugin-sdk').ModulePluginHostShape['messaging'], 'send' | 'subscribe' | 'unsubscribe'>;
}
export interface Command { executable: string; args: string[] }
export interface Profile {
  id: string; label: string; revision: number; provider: 'github' | 'gitlab' | 'organization-cli';
  mode: 'manual' | 'both'; project: string; apiBaseUrl: string; issueCreateUrl: string;
  visibility: 'public' | 'private' | 'unknown'; tokenRef: 'githubToken' | 'gitlabToken';
  command?: Command; attachmentCommand?: Command; attachmentOrigins: string[];
}
export interface ImageBytes { id: string; name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; sha256: string }
export interface Attachment extends ImageBytes { original?: ImageBytes }
export type StoredAttachment = Omit<ImageBytes, 'base64'> & { original?: Omit<ImageBytes, 'base64'> };
export type FeedbackKind = 'bug' | 'feat';
export interface Report { kind?: FeedbackKind; title: string; body: string; attachments: Attachment[] }
export interface StoredReport { kind?: FeedbackKind; title: string; body: string; attachments: StoredAttachment[] }
export interface RemoteIssue { id: string; url: string; title: string; body: string }
export interface Journal {
  version: 1; id: string; owner: string; report: StoredReport; target: Profile; digest: string;
  state: 'draft' | 'approved' | 'writing' | 'upload_failed' | 'unknown' | 'published'; issue?: RemoteIssue; safeError?: string;
  phase?: 'uploading' | 'creating' | 'verifying';
  uploads?: { submissionId: string; sha256: string; markdown: string }[];
  uploadingHash?: string;
  createdAt?: number; updatedAt?: number; reviewReady?: boolean; handoffAt?: number; supersededBy?: string;
}
export type HydratedJournal = Omit<Journal, 'report'> & { report: Report };
export interface Provider {
  preflight(signal: AbortSignal): Promise<{ principal: string; visibility: string; attachments: boolean }>;
  upload(attachment: Attachment, id: string, signal: AbortSignal): Promise<string>;
  create(report: Report, id: string, signal: AbortSignal): Promise<RemoteIssue>;
  reconcile(id: string, signal: AbortSignal): Promise<RemoteIssue | undefined>;
  read(issue: RemoteIssue, signal: AbortSignal): Promise<RemoteIssue>;
}
