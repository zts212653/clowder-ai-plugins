export type ConnectorLogMethod = (...args: readonly unknown[]) => void;

export interface ConnectorLogger {
  info: ConnectorLogMethod;
  warn: ConnectorLogMethod;
  error: ConnectorLogMethod;
  debug: ConnectorLogMethod;
}

export type RichBlock =
  | Readonly<{
      kind: 'card';
      title?: string;
      tone?: string;
      bodyMarkdown?: string;
      fields?: ReadonlyArray<Readonly<{ label: string; value: string }>>;
    }>
  | Readonly<{
      kind: 'checklist';
      title?: string;
      items: ReadonlyArray<Readonly<{ checked?: boolean; text: string }>>;
    }>
  | Readonly<{ kind: 'diff'; filePath: string; languageHint?: string; diff: string }>
  | Readonly<{ kind: 'audio'; text?: string }>
  | Readonly<{
      kind: 'media_gallery';
      title?: string;
      items: ReadonlyArray<Readonly<{ caption?: string; alt?: string; url: string }>>;
    }>;

export interface CardAction {
  readonly label: string;
  readonly value: Record<string, unknown>;
}

export interface MessageEnvelope {
  readonly header: string;
  readonly subtitle: string;
  readonly body: string;
  readonly footer: string;
  readonly origin?: 'callback' | 'agent' | 'system';
  readonly cardActions?: readonly CardAction[];
}

export const DEFAULT_QUICK_ACTIONS: readonly CardAction[] = [
  { label: '➕ 新建', value: { cmd: '/new' } },
  { label: '📋 选择会话', value: { cmd: '/threads' } },
  { label: '📜 历史', value: { cmd: '/history', args: 'pick' } },
  { label: '❓ 帮助', value: { cmd: '/commands' } },
];
