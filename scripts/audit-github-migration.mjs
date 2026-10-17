#!/usr/bin/env node
// Static reachability is a source-map aid, never runtime or parity acceptance.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'packages/github-operations');
const require = createRequire(join(base, 'package.json'));
const ts = require('typescript');
const map = JSON.parse(readFileSync(join(base, 'migration/source-map.json'), 'utf8'));
const local = path => relative(root, path).split('\\').join('/');
const nodes = new Map();
const copyCommit = '6636763168865f4f916b36fce510087d1595df3a';
function withoutTypeImportPaths(text) {
  const file = ts.createSourceFile('comparison.ts', text, ts.ScriptTarget.Latest, true);
  const ranges = file.statements.filter(statement => ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)
    .map(statement => [statement.moduleSpecifier.getStart(file), statement.moduleSpecifier.end]).reverse();
  for (const [start, end] of ranges) text = text.slice(0, start) + '"TYPE_IMPORT"' + text.slice(end);
  return text;
}
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (entry.name.endsWith('.ts')) {
      const text = readFileSync(path, 'utf8');
      const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const imports = [];
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'));
        if (!existsSync(target)) throw new Error(`Unresolved source edge: ${local(path)} -> ${specifier}`);
        const clause = statement.importClause;
        const named = clause?.namedBindings ?? statement.exportClause;
        const typeOnly = statement.isTypeOnly || clause?.isTypeOnly ||
          (!clause?.name && named?.elements?.length > 0 && named.elements.every(element => element.isTypeOnly));
        imports.push({ target, typeOnly: !!typeOnly });
      }
      nodes.set(path, { imports, sha256: createHash('sha256').update(text).digest('hex') });
    }
  }
}
scan(join(base, 'src'));
scan(join(base, 'test'));
const reached = new Set();
function visit(path) {
  if (reached.has(path)) return;
  reached.add(path);
  for (const edge of nodes.get(path)?.imports ?? []) if (!edge.typeOnly) visit(edge.target);
}
visit(join(base, 'src/index.ts'));
visit(join(base, 'src/plugin-entrypoint.ts'));
const entries = map.entries.map(entry => {
  const target = entry.target ?? (typeof entry.removedPackageCopy === 'string' ? entry.removedPackageCopy : null);
  const path = target && join(root, target);
  const exists = path && existsSync(path);
  if (entry.removedPackageCopy && exists) throw new Error(`Retained removed copy: ${target}`);
  if (target && !exists && !entry.removedPackageCopy) throw new Error(`Unaccounted missing copy: ${target}`);
  let comparison = null;
  if (entry.mechanicalComparison) {
    const frozen = execFileSync('git', ['show', `${copyCommit}:${target}`], { cwd: root, encoding: 'utf8' });
    if (createHash('sha256').update(frozen).digest('hex') !== entry.sourceSha256) throw new Error(`Frozen source digest mismatch: ${target}`);
    const current = readFileSync(path, 'utf8');
    comparison = current === frozen ? 'byte-identical-to-frozen-source' :
      withoutTypeImportPaths(current) === withoutTypeImportPaths(frozen) ? 'type-import-path-only' : 'business-body-changed';
    if (comparison !== entry.mechanicalComparison) throw new Error(`Stale mechanical comparison: ${target}: ${comparison}`);
  }
  const importers = path ? [...nodes].flatMap(([from, node]) => node.imports.filter(edge => edge.target === path)
    .map(edge => ({ file: local(from), typeOnly: edge.typeOnly, runtimeReachable: reached.has(from) }))) : [];
  return {
    source: entry.source, frozenSourceSha256: entry.sourceSha256 ?? null,
    target, disposition: entry.disposition, targetSha256: exists ? nodes.get(path)?.sha256 ?? null : null,
    mechanicalComparison: comparison,
    runtimeReachable: exists ? reached.has(path) : false, importers,
    needsDispositionAudit: entry.disposition === 'copied-unadapted',
    // Static import reachability does not imply functional parity or Host cutover.
    hostLegacyRemoved: entry.hostLegacyRemoved === true,
  };
});
console.log(JSON.stringify({ sourceHead: map.sourceHead, packageBaseHead: map.packageBaseHead,
  claim: 'static source reachability only; not parity, installation or deletion evidence',
  sourceCount: entries.length, reachableFiles: reached.size,
  pendingDispositionCount: entries.filter(entry => entry.needsDispositionAudit).length, entries }, null, 2));
