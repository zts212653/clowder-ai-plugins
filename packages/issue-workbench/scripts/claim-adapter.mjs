// Plugin-owned ownership metadata; the frozen Core checkout remains untouched.
export function claimAdapter(name, text) {
  function replace(from, to, count = 1) {
    if (text.split(from).length !== count + 1) throw new Error(`Claim export seam changed: ${name}: ${from}`);
    text = text.replaceAll(from, to);
  }
  if (name === 'issue-source.ts') {
    replace('  labels: string[];', '  labels: string[];\n  /** Provider assignees. Undefined means not read yet; [] means unclaimed. */\n  assignees?: string[];');
    replace('    [...fact.labels].sort(),', '    [...fact.labels].sort(),\n    fact.assignees ? [...fact.assignees].sort() : undefined,');
  }
  if (name === 'GhIssueSourceReader.ts') {
    replace('  labels(first:100)', '  assignees(first:100) { nodes { login } pageInfo { hasNextPage } }\n  labels(first:100)', 2);
    replace("'author' | 'labels' | 'comments'>", "'author' | 'labels' | 'comments' | 'assignees'>");
    replace('  labels: Connection<{ name: string }>;', '  labels: Connection<{ name: string }>;\n  assignees?: Connection<{ login: string }>;');
    replace("            if (raw.labels.pageInfo.hasNextPage) throw new Error('labels incomplete');", "            if (raw.labels.pageInfo.hasNextPage) throw new Error('labels incomplete');\n            if (raw.assignees?.pageInfo.hasNextPage) throw new Error('assignees incomplete');\n            const assignees = raw.assignees?.nodes.map(member => member.login);");
    replace('                ...index,', '                ...index,\n                assignees,');
    replace('              ...fact,', '              ...fact,\n              assignees,');
  }
  if (name === 'IssueSourceService.ts') {
    replace('const full = !previous?.lastFullAt || start - Date.parse(previous.lastFullAt) >= 30 * 60_000;',
      'const full = !previous?.lastFullAt || start - Date.parse(previous.lastFullAt) >= 30 * 60_000\n      || previous.issues.some(fact => !fact.unavailable && fact.assignees === undefined);');
  }
  if (name === 'IssueSourceState.tsx') {
    replace("import styles from './issue-source-state.module.css';", "import styles from './issue-source-state.module.css';\nimport { IssueClaimState } from './IssueClaimState';");
    replace("'state' | 'unavailable'", "'state' | 'unavailable' | 'assignees'");
    replace('  return (\n    <span', '  return (\n    <>\n    <span');
    replace('    </span>\n  );', '    </span>\n    {state === \'OPEN\' && <IssueClaimState assignees={fact.assignees} />}\n    </>\n  );');
  }
  return text;
}
