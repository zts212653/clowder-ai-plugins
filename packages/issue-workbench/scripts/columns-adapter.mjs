// Plugin-owned layout enhancement of the frozen Core UI slice. The adapter is
// explicit so later exports reproduce it, without changing Core or lying about
// source hashes. Behavior lives in src/layout, not in this source transformer.
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`Column layout seam changed: ${from.slice(0, 90)}`);
  return text.replace(from, to);
}
export function columnsAdapter(name, text) {
  if (name === 'CoordinationWorkbench.tsx') {
    text = once(text, "'use client';", "'use client';\nimport { ColumnSeparator } from '../layout/ColumnSeparator';\nimport { useWorkbenchColumns } from '../layout/useWorkbenchColumns';");
    text = once(text, "  const [snapshot, setSnapshot]", "  const columns = useWorkbenchColumns();\n  const [snapshot, setSnapshot]");
    text = once(text, '<main\n', '<main\n      ref={columns.ref}\n      style={columns.style}\n');
    text = once(text, '<aside className={styles.queue}', '<aside id={columns.queue.controls} className={styles.queue}');
    text = once(text, '</aside>\n', '</aside>\n        <ColumnSeparator {...columns.queue} />\n');
    text = once(text, '<section className={styles.inspector}', '<ColumnSeparator {...columns.notes} />\n              <section id={columns.notes.controls} className={styles.inspector}');
  }
  if (name === 'coordination.module.css') {
    text = once(text, '.shell {', '.shell {\n  container: issue-workbench / inline-size;\n  min-width: 0;');
    text = once(text, 'grid-template-columns: 270px minmax(0, 1fr);', 'grid-template-columns: var(--queue-width, 270px) 8px minmax(0, 1fr);');
    text = once(text, 'grid-template-columns: minmax(0, 1fr) 350px;', 'grid-template-columns: minmax(0, 1fr) 8px var(--notes-width, 350px);');
    text = once(text, 'grid-template-columns: 250px minmax(0, 1fr);', 'grid-template-columns: var(--queue-width, 250px) 8px minmax(0, 1fr);');
    text = once(text, '@media (max-width: 1279px)', '@container issue-workbench (max-width: 1100px)');
    text = text.replaceAll('@media (max-width: 720px)', '@container issue-workbench (max-width: 720px)');
    text = once(text, 'max-width: calc(100vw - 40px);', 'max-width: calc(100cqw - 40px);');
    text = once(text, 'max-width: calc(100vw - 24px);', 'max-width: calc(100cqw - 24px);');
    text = once(text, '  border-right: 1px solid var(--cafe-border-subtle);\n  background:', '  background:');
    text = once(text, '  padding: 24px;\n  border-right: 1px solid var(--cafe-border-subtle);', '  padding: 24px;');
  }
  return text;
}
