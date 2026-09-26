export type ConnectorLogMethod = (...args: readonly unknown[]) => void;
export interface ConnectorLogger {
  info: ConnectorLogMethod;
  warn: ConnectorLogMethod;
  error: ConnectorLogMethod;
  debug: ConnectorLogMethod;
}
