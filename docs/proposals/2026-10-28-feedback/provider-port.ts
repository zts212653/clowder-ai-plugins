/** 设计契约草案；不是当前 SDK surface，也不是可安装插件。 */
export type ProviderId = 'github' | 'gitlab' | 'organization-cli';
export type Visibility = 'public' | 'private' | 'confidential' | 'unknown';

/** 手动创建不要求 API 可用，也不要求本地拥有平台 API 凭据。 */
export interface ManualSubmissionTarget {
  readonly mode: 'manual';
  readonly issueCreateUrl: string;
}

export interface AutomaticSubmissionTarget {
  readonly mode: 'automatic';
  readonly transport: 'rest' | 'cli';
  readonly apiBaseUrl: string;
  readonly authRef?: string;
  readonly attachmentStoreRef?: string;
}

export type SubmissionTarget = ManualSubmissionTarget | AutomaticSubmissionTarget | {
  readonly mode: 'both';
  readonly defaultMode: 'manual' | 'automatic';
  readonly manual: ManualSubmissionTarget;
  readonly automatic: AutomaticSubmissionTarget;
};

export interface DestinationProfile {
  readonly id: string;
  readonly revision: number;
  readonly provider: ProviderId;
  readonly submission: SubmissionTarget;
  readonly project: string;
  readonly allowedNetworkOrigins: readonly string[];
  readonly expectedVisibility: Visibility;
}

/** 发布字节由服务器生成／校验，不能接受任意路径或外部 URL 当附件。 */
export interface ApprovedAttachment {
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly fileName: string;
}

export interface ApprovedPublication {
  readonly submissionMode: 'automatic';
  readonly submissionId: string;
  readonly destination: DestinationProfile;
  readonly reportRevision: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly contentDigest: string;
  readonly attachments: readonly ApprovedAttachment[];
  /** Host 验证的用户确认引用；agent 不能自行生成。 */
  readonly confirmationRef: string;
}

/** 浏览器跳转不构成建单回执；标题／正文不能拼进 URL。 */
export interface ManualHandoffReceipt {
  readonly state: 'page_open_requested';
  readonly destinationId: string;
  readonly destinationRevision: number;
  readonly reportRevision: number;
  readonly issueCreateUrl: string;
  readonly attachmentDelivery: 'user-adds-on-issue-page';
  readonly remoteIssueCreated: false;
}

export interface ProviderContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
  assertCurrent(): Promise<void>;
  readApprovedBytes(ref: string): AsyncIterable<Uint8Array>;
}

export interface RemoteIssue {
  readonly id: string;
  readonly displayNumber: string;
  readonly url: string;
  readonly target: string;
  readonly visibility: Visibility;
  readonly title: string;
  readonly bodyMarkdown: string;
}

export interface AttachmentReceipt {
  readonly submissionId: string;
  readonly contentSha256: string;
  readonly remoteId: string;
  readonly markdown: string;
  readonly remoteOrigin: string;
  readonly visibility: Visibility;
}

/** 不用 throw／重试隐藏“请求可能已经在远端成功”的事实。 */
export type WriteOutcome<T> =
  | { readonly state: 'confirmed'; readonly value: T }
  | { readonly state: 'rejected'; readonly code: string; readonly safeMessage: string }
  | { readonly state: 'unknown'; readonly reconciliationRef: string };

export interface IssueProvider {
  readonly id: ProviderId;
  validateTarget(profile: DestinationProfile): Promise<void>;
  preflight(profile: DestinationProfile, context: ProviderContext): Promise<{
    readonly principal: string;
    readonly canonicalTarget: string;
    readonly visibility: Visibility;
    readonly canCreate: boolean;
    readonly attachments: 'supported' | 'requires-store' | 'unavailable';
    readonly canReconcileCreation: boolean;
  }>;
  uploadAttachment(publication: ApprovedPublication, attachment: ApprovedAttachment,
    context: ProviderContext): Promise<WriteOutcome<AttachmentReceipt>>;
  createIssue(publication: ApprovedPublication, receipts: readonly AttachmentReceipt[],
    context: ProviderContext): Promise<WriteOutcome<RemoteIssue>>;
  /** 查不到不意味着未创建；不得据此自动再次 create。 */
  findBySubmissionId(publication: ApprovedPublication, context: ProviderContext): Promise<
    | { readonly state: 'found'; readonly issue: RemoteIssue }
    | { readonly state: 'unknown' }
  >;
  readIssue(issue: RemoteIssue, context: ProviderContext): Promise<RemoteIssue>;
}

/** 内网组织 CLI 以有界 JSON 交互；配置不得承载 shell 脚本。 */
export interface OrganizationCliProfile {
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly protocolVersion: '1';
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly envAllowlist: readonly string[];
  readonly shell: false;
}
