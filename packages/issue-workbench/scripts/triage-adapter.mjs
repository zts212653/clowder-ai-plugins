import { readFileSync } from 'node:fs';

// Reviewed plugin-side delta against the frozen Core export. Keep original Core
// source hashes; fail on changed seams rather than silently dropping local work.
const patches = JSON.parse(readFileSync(new URL('./triage-adapter.json', import.meta.url), 'utf8'));
export function triageAdapter(name, text) {
  const patch = patches.find(entry => entry.name === name);
  for (const change of patch?.replacements ?? []) {
    const from = change.from.join('\n') + '\n', to = change.to.join('\n') + '\n';
    if (text.split(from).length !== 2) throw new Error('Classification UI seam changed: ' + name);
    text = text.replace(from, to);
  }
  return text;
}
