import { collectiveModelImageSchema, collectiveModelMediaSchema } from './business/contracts/index.js';

/** Only the authenticated context reader can return a typed model image.
 * Arbitrary module action objects are never treated as MCP content blocks. */
export function collectiveNativeToolResult(method: string, result: unknown) {
  if (
    method === 'collective.context.read' &&
    result !== null &&
    typeof result === 'object' &&
    'kind' in result &&
    result.kind === 'collective_model_media'
  ) {
    const media = collectiveModelMediaSchema.parse(result);
    if (media.content.type === 'video') {
      const { dataBase64, ...frame } = media.content.frame;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...media,
              content: { ...media.content, frame },
            }),
          },
          {
            type: 'image' as const,
            data: dataBase64,
            mimeType: media.content.frame.mediaType,
          },
        ],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(media) }],
    };
  }
  if (
    method === 'collective.context.read' &&
    result !== null &&
    typeof result === 'object' &&
    'kind' in result &&
    result.kind === 'collective_model_image'
  ) {
    const image = collectiveModelImageSchema.parse(result);
    const { dataBase64, ...source } = image;
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(source) },
        { type: 'image' as const, data: dataBase64, mimeType: image.mediaType },
      ],
    };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}
