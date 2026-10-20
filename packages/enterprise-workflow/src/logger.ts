import type { FeatureContext } from '@clowder-ai/plugin-sdk';

export type EnterpriseLogMethod = {
  (message: string): void;
  (fields: unknown, message: string): void;
};

export interface EnterpriseLogger {
  readonly debug: EnterpriseLogMethod;
  readonly info: EnterpriseLogMethod;
  readonly warn: EnterpriseLogMethod;
  readonly error: EnterpriseLogMethod;
}

function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : value === undefined
      ? undefined
      : { value };
}

export function featureLogger(context: FeatureContext): EnterpriseLogger {
  const method = (level: 'debug' | 'info' | 'warn' | 'error'): EnterpriseLogMethod => (
    first: string | unknown,
    second?: string,
  ) => {
    if (typeof first === 'string' && second === undefined) context.log(level, first);
    else context.log(level, second ?? 'Enterprise workflow event', fields(first));
  };
  return {
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
  };
}
