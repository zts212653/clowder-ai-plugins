import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

test('every emitted module declares its external runtime dependencies, including non-entry modules', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const missing = new Set<string>();
  async function scan(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { await scan(path); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const file = ts.createSourceFile(path.pathname, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function inspect(node: ts.Node): void {
        const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier :
          ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text;
          if (!name.startsWith('.') && !name.startsWith('node:') && !builtinModules.includes(name)) {
            const dependency = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!;
            if (!declared.has(dependency)) missing.add(`${path.pathname.split('/dist/')[1]}: ${dependency}`);
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(file);
    }
  }
  await scan(new URL('../dist/', import.meta.url));
  assert.deepEqual([...missing].sort(), []);
});
