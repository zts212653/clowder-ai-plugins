export function targetQuery({ query = '', kind = 'all', limit = 50 } = {}) {
  if (typeof query !== 'string' || query.length > 128 || /[\u0000-\u001f]/.test(query) || !['all', 'direct', 'group'].includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw Error('invalid target search');
  return { query: query.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' '), kind, limit };
}
function score(value, term) {
  const text = value.normalize('NFKC').toLocaleLowerCase();
  const index = text.indexOf(term);
  if (index >= 0) return text === term ? 0 : index === 0 ? 2 : 5 + index;
  let position = 0, distance = 0;
  for (const character of term) {
    const next = text.indexOf(character, position);
    if (next < 0) return Infinity;
    distance += next - position; position = next + character.length;
  }
  return 50 + distance;
}
export function searchTargets(items, { query, kind }) {
  const candidates = items.filter(item => kind === 'all' || item.kind === kind);
  if (!query) return candidates;
  return candidates.map(item => {
    const fields = [item.displayName, item.nickname, item.remark, item.alias, item.id].filter(value => typeof value === 'string');
    return { item, score: query.split(' ').reduce((total, term) => total + Math.min(...fields.map(field => score(field, term))), 0) };
  }).filter(result => Number.isFinite(result.score)).sort((a, b) => a.score - b.score || a.item.id.localeCompare(b.item.id)).map(result => result.item);
}
