// Pass the already loaded classification into the plugin-owned detail slot.
// This is a reproducible extension of the frozen export, not a Core change.
export function teamToolsAdapter(name, text) {
  if (name !== 'CoordinationWorkbench.tsx') return text;
  for (const [from, to] of [
    ['  issueTools,\n', '  issueTools,\n  projectSnapshot,\n'],
    ['  tools?: ReactNode;', '  tools?: ReactNode;\n  projectSnapshot?: (snapshot: CoordinationSnapshot) => CoordinationSnapshot;'],
    ['  const [snapshot, setSnapshot] = useState<CoordinationSnapshot>({ sources: [], relations: [] });',
      '  const [sourceSnapshot, setSnapshot] = useState<CoordinationSnapshot>({ sources: [], relations: [] });\n  const snapshot = projectSnapshot ? projectSnapshot(sourceSnapshot) : sourceSnapshot;'],
    ['issueTools?: (profile: IssueSourceProfile, fact: IssueSourceFact)',
      'issueTools?: (profile: IssueSourceProfile, fact: IssueSourceFact, category: string)'],
    ['issueTools?.(row.source.profile, row.fact)', 'issueTools?.(row.source.profile, row.fact, issueCategory(row).label)'],
  ]) {
    if (text.split(from).length !== 2) throw new Error('Team detail slot changed: ' + from);
    text = text.replace(from, to);
  }
  return text;
}
