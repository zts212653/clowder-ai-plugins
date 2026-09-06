import { attrsOf, childrenOf, xmlParser, type XNode } from '@genoffice/docx-engine/xml-utils';

const wordNamespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);

// The frozen parser leaves numeric references in attributes. Decode XML's five
// predefined entities and character references exactly once (never expand DTDs).
function attributeValue(value: string): string {
  const predefined: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|quot|apos|lt|gt);/g, (_, entity: string) => {
    if (!entity.startsWith('#')) return predefined[entity] ?? '';
    return String.fromCodePoint(entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}

/** Inventory parsed attributes: quotes, character references, prefix aliases and
 * scoped namespace rebinding cannot change the identity of an existing ID.
 */
export function usedWordIds(documentXml: string): Set<string> {
  const used = new Set<string>();
  const pending = (xmlParser.parse(documentXml) as XNode[]).map(node => ({ node, namespaces: new Map<string, string>() }));
  let count = 0;
  while (pending.length) {
    if (++count > 262144) throw new Error('XML inventory budget exceeded');
    const current = pending.pop();
    if (!current) break;
    const attributes = attrsOf(current.node);
    const namespaces = new Map(current.namespaces);
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('xmlns:')) namespaces.set(name.slice(6), attributeValue(value));
    }
    for (const [name, value] of Object.entries(attributes)) {
      const split = name.lastIndexOf(':');
      if (split < 1 || name.slice(split + 1) !== 'id' || !wordNamespaces.has(namespaces.get(name.slice(0, split)) ?? '')) continue;
      // ST_DecimalNumber has numeric identity, including +0 and leading zeroes.
      const normalized = attributeValue(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
      used.add(/^[+-]?\d+$/.test(normalized) ? BigInt(normalized).toString() : normalized);
    }
    for (const node of childrenOf(current.node)) pending.push({ node, namespaces });
  }
  return used;
}
