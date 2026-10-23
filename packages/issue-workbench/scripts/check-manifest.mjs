// Repository-only check against the current public contract; not an SDK runtime dependency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateManifest } from '../../plugin-contract/dist/index.js';
const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const result = validateManifest(manifest);
assert.equal(result.valid, true, JSON.stringify(result.errors));
console.log('Declaration candidate conforms to the repository manifest schema (not an install claim)');
