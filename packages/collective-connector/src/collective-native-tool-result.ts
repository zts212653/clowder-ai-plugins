import { collectiveModelImageSchema } from './business/contracts/index.js';

/** Only the authenticated context reader can return a typed model image.
 * Arbitrary module action objects are never treated as MCP content blocks. */
export function collectiveNativeToolResult(method: string, result: unknown) {
  if (method === 'collective.context.read' && result !== null && typeof result === 'object' &&
      'kind' in result && result.kind === 'collective_model_image') {
    const image = collectiveModelImageSchema.parse(result);
    const { dataBase64, ...source } = image;
    return { content: [
      { type: 'text' as const, text: JSON.stringify(source) },
      { type: 'image' as const, data: dataBase64, mimeType: image.mediaType },
    ] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}
