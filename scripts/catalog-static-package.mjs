import assert from 'node:assert/strict';

export function assertStaticPackageDependencies(packageJson, contributions) {
  assert.doesNotMatch(JSON.stringify(packageJson), /"workspace:/u);
  if (!contributions.some(entry => entry.type === 'desktop-window')) return;
  assert.deepEqual(packageJson.dependencies ?? {}, {}, 'desktop packages must bundle their browser code without runtime dependencies');
  assert.deepEqual(packageJson.optionalDependencies ?? {}, {}, 'desktop packages cannot defer optional runtime dependencies');
}
