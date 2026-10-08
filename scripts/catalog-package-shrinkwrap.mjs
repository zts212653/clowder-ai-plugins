import assert from 'node:assert/strict';

const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function dependencyPackagePaths(packagePath, dependencyName) {
  const paths = [`${packagePath}/node_modules/${dependencyName}`];
  let currentPath = packagePath;

  while (true) {
    const nestedBoundary = currentPath.lastIndexOf('/node_modules/');
    if (nestedBoundary < 0) {
      paths.push(`node_modules/${dependencyName}`);
      return paths;
    }

    currentPath = currentPath.slice(0, nestedBoundary);
    paths.push(`${currentPath}/node_modules/${dependencyName}`);
  }
}

function resolveDependencyEntry(packages, packagePath, dependencyName) {
  for (const candidatePath of dependencyPackagePaths(packagePath, dependencyName)) {
    const entry = packages[candidatePath];
    if (entry) return { entry, packagePath: candidatePath };
  }
  return undefined;
}

function assertRequestedVersion(dependencyName, requestedVersion, entry) {
  if (exactVersionPattern.test(requestedVersion)) {
    assert.equal(
      entry.version,
      requestedVersion,
      `npm-shrinkwrap.json resolves ${dependencyName} to ${entry.version}, expected ${requestedVersion}`,
    );
  }
}

function assertRegistryResolution(packagePath, entry) {
  assert.match(
    entry.resolved ?? '',
    /^https:\/\/registry\.npmjs\.org\//u,
    `${packagePath} must resolve from https://registry.npmjs.org/`,
  );
}

export function assertProductionDependencyClosure(packageJson, shrinkwrap) {
  const packages = shrinkwrap.packages ?? {};
  const rootEntry = packages[''];
  assert.ok(rootEntry, 'npm-shrinkwrap.json is missing its root package entry');
  assert.deepEqual(
    rootEntry.dependencies ?? {},
    packageJson.dependencies ?? {},
    'npm-shrinkwrap.json root dependencies do not match package.json',
  );
  assert.deepEqual(
    rootEntry.optionalDependencies ?? {},
    packageJson.optionalDependencies ?? {},
    'npm-shrinkwrap.json root optionalDependencies do not match package.json',
  );
  const directDependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
  const pending = [];

  for (const [dependencyName, requestedVersion] of Object.entries(directDependencies)) {
    const packagePath = `node_modules/${dependencyName}`;
    const entry = packages[packagePath];
    assert.ok(entry, `npm-shrinkwrap.json is missing direct dependency ${packagePath}`);
    assertRequestedVersion(dependencyName, requestedVersion, entry);
    pending.push(packagePath);
  }

  const visited = new Set();
  while (pending.length > 0) {
    const packagePath = pending.pop();
    if (visited.has(packagePath)) continue;
    visited.add(packagePath);

    const entry = packages[packagePath];
    assertRegistryResolution(packagePath, entry);

    for (const [kind, dependencies] of [
      ['production', entry.dependencies ?? {}],
      ['optional production', entry.optionalDependencies ?? {}],
    ]) {
      for (const [dependencyName, requestedVersion] of Object.entries(dependencies)) {
        const resolved = resolveDependencyEntry(packages, packagePath, dependencyName);
        assert.ok(
          resolved,
          `${packagePath.replace(/^node_modules\//u, '')} requires missing ${kind} dependency ${dependencyName}`,
        );
        assertRequestedVersion(dependencyName, requestedVersion, resolved.entry);
        pending.push(resolved.packagePath);
      }
    }
  }
}

export function assertWorkspaceSdkContractClosure(
  shrinkwrap,
  { contractVersion },
) {
  const packages = shrinkwrap.packages ?? {};
  const sdkPath = 'node_modules/@clowder-ai/plugin-sdk';
  const sdkEntry = packages[sdkPath];
  if (!sdkEntry) return;

  assert.equal(
    sdkEntry.dependencies?.['@clowder-ai/plugin-contract'],
    contractVersion,
    `npm-shrinkwrap.json resolves @clowder-ai/plugin-sdk@${sdkEntry.version} through a stale @clowder-ai/plugin-contract dependency`,
  );
  const resolved = resolveDependencyEntry(packages, sdkPath, '@clowder-ai/plugin-contract');
  assert.ok(resolved, 'npm-shrinkwrap.json is missing the workspace SDK contract dependency');
  assert.equal(
    resolved.entry.version,
    contractVersion,
    `npm-shrinkwrap.json resolves the workspace SDK contract to ${resolved.entry.version}, expected ${contractVersion}`,
  );
}

export function collectWorkspacePackageIntegrityMismatches(
  shrinkwrap,
  workspacePackages,
) {
  const packages = shrinkwrap.packages ?? {};
  const mismatches = [];

  for (const [packageName, expected] of Object.entries(workspacePackages)) {
    const packagePath = `node_modules/${packageName}`;
    const entry = packages[packagePath];
    if (!entry || entry.version !== expected.version) continue;
    if (entry.integrity === expected.integrity) continue;

    mismatches.push({
      packageName,
      packagePath,
      version: entry.version,
      actualIntegrity: entry.integrity,
      expectedIntegrity: expected.integrity,
    });
  }

  return mismatches;
}
