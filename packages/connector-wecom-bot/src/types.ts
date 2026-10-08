export type ConnectorLogMethod = (...args: readonly unknown[]) => void;

export interface ConnectorLogger {
  info: ConnectorLogMethod;
  warn: ConnectorLogMethod;
  error: ConnectorLogMethod;
  debug?: ConnectorLogMethod;
}

export type RichBlock = Readonly<Record<string, unknown>>;

export interface MessageEnvelope {
  header: string;
  body: string;
  origin: 'direct' | 'callback';
  subtitle?: string;
  footer?: string;
}
