export function acquireProcessLease(path: string, options: { label: string }): Promise<{ release(): Promise<void> }>;
