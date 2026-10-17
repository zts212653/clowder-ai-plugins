export function parseRules(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ].sort();
}
export function selectableRule(path) {
  return (
    Boolean(path) &&
    path.trim() === path &&
    !path.startsWith('/') &&
    !/[\\:*?<>|"]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32) &&
    !path
      .replace(/\/$/, '')
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}
export function ruleState(rules, path) {
  const inherited = rules.find((rule) => rule.endsWith('/') && rule !== path && path.startsWith(rule)) ?? null;
  return {
    checked: rules.includes(path) || Boolean(inherited),
    inherited,
    partial: path.endsWith('/') && !rules.includes(path) && !inherited && rules.some((rule) => rule.startsWith(path)),
  };
}
export function toggleRule(rules, path, checked) {
  if (ruleState(rules, path).inherited) return [...rules];
  const next = rules.filter((rule) => rule !== path && !(checked && path.endsWith('/') && rule.startsWith(path)));
  if (checked) next.push(path);
  return [...new Set(next)].sort();
}

export function ruleDraft(saved, current) {
  const before = new Set(saved),
    after = new Set(current);
  const added = [...after].filter((path) => !before.has(path));
  const removed = [...before].filter((path) => !after.has(path));
  return { dirty: added.length + removed.length > 0, added, removed };
}
export function savedRules(panel) {
  try {
    return parseRules(JSON.parse(panel?.dataset.savedRules ?? '[]').join('\n'));
  } catch {
    return [];
  }
}
