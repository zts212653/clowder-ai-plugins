/** These SDK ports contain asynchronous methods only. Preserve their API and receiver. */
export function fenceAsyncPort<T extends object>(port: T, assertCurrent: () => Promise<void>): T {
    return new Proxy(port, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (typeof value !== 'function')
                return value;
            return async (...args: unknown[]) => {
                await assertCurrent();
                const result = await Reflect.apply(value, target, args);
                await assertCurrent();
                return result;
            };
        },
    });
}

/** Cancel waiting on a read-only authority check; never use this to abandon an admitted Host write. */
export async function awaitAbortableFence(check: () => Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        await Promise.race([check(), cancelled]);
        signal.throwIfAborted();
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
