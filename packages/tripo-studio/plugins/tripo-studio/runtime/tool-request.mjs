const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
// Leave ten seconds for owned browser/process cleanup before the Host's 60s deadline.
export const TOOL_BUDGET_MS = 50000;
export const wrapTool =
  (handler, { timeoutMs = TOOL_BUDGET_MS } = {}) =>
  async (args, extra = {}) => {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(extra.signal ? [extra.signal] : [])]);
    try {
      signal.throwIfAborted();
      const value = await handler(args, { ...extra, signal });
      signal.throwIfAborted();
      return result(value);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
