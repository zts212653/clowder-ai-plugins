/** Read human-friendly Markdown and the legacy JSON report, allowing the normal
 * Client signature outside the report. Never evaluate model output as markup. */
export function parseReport(content: string): {title: string; body: string} | undefined {
  const stripSignature = (value: string) => value.trim().replace(/(?:\n\s*)?\[[^\]\n]{1,120}\/[^\]\n]{1,120}\]\s*$/u, '').trim();
  const cleaned = stripSignature(content).replace(/^\s*```(?:json|markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  let title: unknown; let body: unknown;
  if (cleaned.startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(cleaned); } catch { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    ({title, body} = value as Record<string, unknown>);
    if (typeof body === 'string' && !body.includes('\n') && body.includes('\\n')) body = body.replaceAll('\\n', '\n');
  } else {
    const match = /(?:^|\n)#\s+([^\n]+)\n+([\s\S]+)$/.exec(cleaned);
    title = match?.[1]; body = match?.[2];
  }
  if (typeof title !== 'string' || typeof body !== 'string' || !title.trim() || !body.trim() || title.length > 200 || body.length > 100_000) return undefined;
  // Chinese labels with a colon inside closing ** are not right-flanking
  // emphasis in CommonMark. Keep the label bold and move its punctuation out.
  return {title: title.trim(), body: stripSignature(body).replace(/\*\*((?:事实|推测|未验证|预期|实际)(?:[（(][^\n)）]{1,40}[)）])?)[：:]\*\*/g, '**$1**：')};
}
