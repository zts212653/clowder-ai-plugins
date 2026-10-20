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
