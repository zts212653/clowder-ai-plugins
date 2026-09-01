import { createRequire } from 'node:module';

import type {
  CatalogPluginEntry,
  CatalogPluginVersion,
  PluginCatalog,
} from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: { readonly allErrors: boolean; readonly strict: boolean }) => AjvInstance =
  require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const catalogSchema = require('@clowder-ai/plugin-contract/schemas/catalog') as Record<string, unknown>;

interface AjvErrorObject {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message?: string;
}

interface AjvValidateFunction {
  (value: unknown): boolean;
  readonly errors?: readonly AjvErrorObject[] | null;
}

interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

export interface CatalogValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type CatalogValidationResult =
  | { readonly valid: true; readonly catalog: PluginCatalog; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly CatalogValidationError[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(catalogSchema);

function semanticError(
  instancePath: string,
  schemaPath: string,
  keyword: string,
  message: string,
): CatalogValidationResult {
  return { valid: false, errors: [{ instancePath, schemaPath, keyword, message }] };
}

interface ParsedSemVer {
  readonly numbers: readonly [string, string, string];
  readonly prerelease: readonly string[];
}

function parseSemVer(value: string): ParsedSemVer {
  const buildIndex = value.indexOf('+');
  const withoutBuild = buildIndex === -1 ? value : value.slice(0, buildIndex);
  const prereleaseIndex = withoutBuild.indexOf('-');
  const core = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
  const prerelease = prereleaseIndex === -1 ? '' : withoutBuild.slice(prereleaseIndex + 1);
  const [major, minor, patch] = core.split('.');
  return {
    numbers: [major!, minor!, patch!],
    prerelease: prerelease === '' ? [] : prerelease.split('.'),
  };
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  const lengthDelta = left.length - right.length;
  return lengthDelta === 0 ? compareAscii(left, right) : lengthDelta;
}

function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    const delta = compareNumericIdentifier(a.numbers[index]!, b.numbers[index]!);
    if (delta !== 0) return delta;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^[0-9]+$/.test(aPart);
    const bNumeric = /^[0-9]+$/.test(bPart);
    if (aNumeric && bNumeric) return compareNumericIdentifier(aPart, bPart);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return compareAscii(aPart, bPart);
  }
  return 0;
}

/** Validate repository-owned discovery truth without creating Host inventory state. */
export function validatePluginCatalog(value: unknown): CatalogValidationResult {
  if (!validateSchema(value)) {
    return {
      valid: false,
      errors: (validateSchema.errors ?? []).map((error) => ({
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
        keyword: error.keyword,
        message: error.message ?? 'catalog validation failed',
      })),
    };
  }

  const catalog = value as PluginCatalog;
  const pluginIds = new Set<string>();
  let priorPluginId: string | undefined;
  for (const [pluginIndex, plugin] of catalog.plugins.entries()) {
    if (pluginIds.has(plugin.pluginId)) {
      return semanticError(
        `/plugins/${pluginIndex}/pluginId`,
        '#/$defs/CatalogPluginEntry/uniquePluginIds',
        'uniquePluginIds',
        'pluginId must be declared at most once per catalog',
      );
    }
    if (priorPluginId !== undefined && compareAscii(priorPluginId, plugin.pluginId) >= 0) {
      return semanticError(
        `/plugins/${pluginIndex}/pluginId`,
        '#/properties/plugins/deterministicOrder',
        'deterministicOrder',
        'catalog plugins must be sorted by pluginId',
      );
    }
    pluginIds.add(plugin.pluginId);
    priorPluginId = plugin.pluginId;

    let priorKeyword: string | undefined;
    for (const [keywordIndex, keyword] of (plugin.keywords ?? []).entries()) {
      if (priorKeyword !== undefined && compareAscii(priorKeyword, keyword) >= 0) {
        return semanticError(
          `/plugins/${pluginIndex}/keywords/${keywordIndex}`,
          '#/$defs/CatalogPluginEntry/deterministicKeywordOrder',
          'deterministicKeywordOrder',
          'catalog keywords must be unique and sorted by ASCII code point',
        );
      }
      priorKeyword = keyword;
    }

    const versions = new Set<string>();
    let priorVersion: string | undefined;
    for (const [versionIndex, version] of plugin.versions.entries()) {
      if (versions.has(version.version)) {
        return semanticError(
          `/plugins/${pluginIndex}/versions/${versionIndex}/version`,
          '#/$defs/CatalogPluginVersion/uniqueVersions',
          'uniqueVersions',
          'version must be declared at most once per plugin',
        );
      }
      if (version.artifact.version !== version.version) {
        return semanticError(
          `/plugins/${pluginIndex}/versions/${versionIndex}/artifact/version`,
          '#/$defs/CatalogPluginVersion/artifactVersionMatches',
          'artifactVersionMatches',
          'artifact version must exactly match the catalog version',
        );
      }
      const unscopedPackageName = version.artifact.packageName.slice(
        version.artifact.packageName.indexOf('/') + 1,
      );
      const expectedTarballUrl =
        `https://registry.npmjs.org/${version.artifact.packageName}/-/` +
        `${unscopedPackageName}-${version.version}.tgz`;
      if (version.artifact.tarballUrl !== expectedTarballUrl) {
        return semanticError(
          `/plugins/${pluginIndex}/versions/${versionIndex}/artifact/tarballUrl`,
          '#/$defs/NpmArtifact/packageVersionTarball',
          'packageVersionTarball',
          'npm tarball URL must exactly match the declared package name and version',
        );
      }
      if (priorVersion !== undefined && compareSemVer(priorVersion, version.version) <= 0) {
        return semanticError(
          `/plugins/${pluginIndex}/versions/${versionIndex}/version`,
          '#/$defs/CatalogPluginVersion/descendingOrder',
          'descendingOrder',
          'catalog versions must be in descending semantic-version order',
        );
      }
      versions.add(version.version);
      priorVersion = version.version;
    }
  }
  return { valid: true, catalog, errors: [] };
}

export function listCatalogPlugins(catalog: PluginCatalog): readonly CatalogPluginEntry[] {
  return catalog.plugins;
}

export function searchCatalogPlugins(
  catalog: PluginCatalog,
  query: string,
): readonly CatalogPluginEntry[] {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (normalized === '') return catalog.plugins;
  return catalog.plugins.filter((plugin) =>
    [plugin.pluginId, plugin.name, plugin.description ?? '', ...(plugin.keywords ?? [])].some(
      (field) => field.toLocaleLowerCase('en-US').includes(normalized),
    ),
  );
}

export function getCatalogPlugin(
  catalog: PluginCatalog,
  pluginId: string,
  version?: string,
): CatalogPluginVersion | undefined {
  const plugin = catalog.plugins.find((entry) => entry.pluginId === pluginId);
  if (plugin === undefined) return undefined;
  return version === undefined
    ? plugin.versions[0]
    : plugin.versions.find((entry) => entry.version === version);
}
