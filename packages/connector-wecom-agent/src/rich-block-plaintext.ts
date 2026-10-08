type RichBlockLike = Readonly<Record<string, unknown>>;

export function renderRichBlockPlaintext(block: RichBlockLike): string {
  switch (block.kind) {
    case 'card': {
      const parts = [`📋 ${block.title}`];
      if (block.bodyMarkdown) parts.push(String(block.bodyMarkdown));
      if (Array.isArray(block.fields) && block.fields.length > 0) {
        parts.push(block.fields
          .map((field) => `  ${(field as Record<string, unknown>).label}: ${(field as Record<string, unknown>).value}`)
          .join('\n'));
      }
      return parts.join('\n');
    }
    case 'checklist': {
      const header = block.title ? `☑️ ${block.title}` : '☑️ Checklist';
      const items = Array.isArray(block.items)
        ? block.items
          .map((item) => `${(item as Record<string, unknown>).checked ? '✅' : '☐'} ${(item as Record<string, unknown>).text}`)
          .join('\n')
        : '';
      return `${header}\n${items}`;
    }
    case 'diff':
      return `📝 ${block.filePath}\n\`\`\`\n${block.diff}\n\`\`\``;
    case 'audio':
      return block.text ? `🔊 ${block.text}` : `🔊 [Audio: ${block.url}]`;
    case 'media_gallery': {
      const header = block.title ? `🖼️ ${block.title}` : '🖼️ Gallery';
      const items = Array.isArray(block.items)
        ? block.items
          .map((item) => (item as Record<string, unknown>).caption
            || (item as Record<string, unknown>).alt
            || (item as Record<string, unknown>).url)
          .join('\n')
        : '';
      return `${header}\n${items}`;
    }
    default:
      return `[${block.kind}]`;
  }
}

export function renderAllRichBlocksPlaintext(blocks: readonly RichBlockLike[]): string {
  return blocks.map(renderRichBlockPlaintext).join('\n\n');
}
