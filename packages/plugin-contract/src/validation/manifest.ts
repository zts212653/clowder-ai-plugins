import { createRequire } from 'node:module';

import type { PluginManifest } from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: {
  readonly allErrors: boolean;
  readonly strict: boolean;
}) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const pluginMetadataSchema = require(
  '@clowder-ai/plugin-contract/schemas/plugin-metadata'
) as Record<string, unknown>;
const manifestSchema = require('@clowder-ai/plugin-contract/schemas/manifest') as Record<
  string,
  unknown
>;
const signalSchema = require('@clowder-ai/plugin-contract/schemas/signals') as Record<
  string,
  unknown
>;

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
  addSchema(schema: Record<string, unknown>, id?: string): void;
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

export interface ManifestValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type ManifestValidationResult =
  | {
      readonly valid: true;
      readonly manifest: PluginManifest;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly errors: readonly ManifestValidationError[];
    };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(pluginMetadataSchema, pluginMetadataSchema['$id'] as string);
ajv.addSchema(signalSchema, signalSchema['$id'] as string);
const validateSchema = ajv.compile(manifestSchema);

function semanticError(
  instancePath: string,
  schemaPath: string,
  keyword: string,
  message: string,
): ManifestValidationResult {
  return {
    valid: false,
    errors: [{ instancePath, schemaPath, keyword, message }],
  };
}

/**
 * Validates an untrusted plugin manifest against the contract-owned schema.
 *
 * The schema is resolved through the package's public export so runtime users
 * and the conformance suite share one manifest definition and Ajv policy.
 */
export function validateManifest(value: unknown): ManifestValidationResult {
  if (validateSchema(value)) {
    const manifest = value as PluginManifest;
    const declaredTypes = new Set<string>();
    for (const [index, declaration] of (manifest.signals?.provides ?? []).entries()) {
      if (declaredTypes.has(declaration.type)) {
        return {
          valid: false,
          errors: [
            {
              instancePath: `/signals/provides/${index}/type`,
              schemaPath: '#/$defs/SignalContribution/uniqueSignalTypes',
              keyword: 'uniqueSignalTypes',
              message: 'signal type must be declared at most once per manifest',
            },
          ],
        };
      }
      declaredTypes.add(declaration.type);
    }

    const featureIds = new Set<string>();
    for (const [index, feature] of manifest.features.entries()) {
      if (featureIds.has(feature.id)) {
        return semanticError(
          `/features/${index}/id`,
          '#/$defs/PluginFeature/uniqueFeatureIds',
          'uniqueFeatureIds',
          'feature id must be declared at most once per manifest',
        );
      }
      featureIds.add(feature.id);
    }

    const configuration = manifest.configuration ?? [];
    const configByKey = new Map<string, (typeof configuration)[number]>();
    for (const [index, field] of configuration.entries()) {
      if (configByKey.has(field.key)) {
        return semanticError(
          `/configuration/${index}/key`,
          '#/$defs/ConfigurationField/uniqueConfigurationKeys',
          'uniqueConfigurationKeys',
          'configuration key must be declared at most once per manifest',
        );
      }
      configByKey.set(field.key, field);
      if (field.kind === 'select') {
        const optionValues = new Set<string>();
        for (const [optionIndex, option] of (field.options ?? []).entries()) {
          if (optionValues.has(option.value)) {
            return semanticError(
              `/configuration/${index}/options/${optionIndex}/value`,
              '#/$defs/ConfigurationOption/uniqueOptionValues',
              'uniqueOptionValues',
              'select option values must be unique within one configuration field',
            );
          }
          optionValues.add(option.value);
        }
        if (field.default !== undefined && !optionValues.has(field.default as string)) {
          return semanticError(
            `/configuration/${index}/default`,
            '#/$defs/ConfigurationField/defaultDeclaredBySelect',
            'defaultDeclaredBySelect',
            'select default must equal one of the declared option values',
          );
        }
      }
    }

    const contributions = manifest.contributions ?? [];
    const contributionByKey = new Map<string, (typeof contributions)[number]>();
    for (const [index, contribution] of contributions.entries()) {
      const key = `${contribution.type}\0${contribution.id}`;
      if (contributionByKey.has(key)) {
        return semanticError(
          `/contributions/${index}/id`,
          '#/$defs/StaticContribution/uniqueContributionKeys',
          'uniqueContributionKeys',
          'contribution type/id must be declared at most once per manifest',
        );
      }
      contributionByKey.set(key, contribution);

      if ('environment' in contribution && contribution.environment !== undefined) {
        for (const [environmentName, binding] of Object.entries(contribution.environment)) {
          const field = configByKey.get(binding.key);
          if (field === undefined) {
            return semanticError(
              `/contributions/${index}/environment/${environmentName}/key`,
              '#/$defs/EnvironmentBinding/declaredConfigurationKey',
              'declaredConfigurationKey',
              'environment binding must reference a declared configuration key',
            );
          }
          if (
            (binding.source === 'secret' && field.kind !== 'secret') ||
            (binding.source === 'config' && field.kind === 'secret')
          ) {
            return semanticError(
              `/contributions/${index}/environment/${environmentName}/source`,
              '#/$defs/EnvironmentBinding/sourceMatchesConfigurationKind',
              'sourceMatchesConfigurationKind',
              'secret bindings must reference secret fields and config bindings must not',
            );
          }
        }
      }
      if (contribution.type === 'webhook' && contribution.verificationSecretRef !== undefined) {
        const secret = configByKey.get(contribution.verificationSecretRef);
        if (secret?.kind !== 'secret') {
          return semanticError(
            `/contributions/${index}/verificationSecretRef`,
            '#/$defs/WebhookContribution/declaredSecretReference',
            'declaredSecretReference',
            'webhook verificationSecretRef must reference a declared secret field',
          );
        }
      }
    }

    for (const [index, contribution] of contributions.entries()) {
      if (
        contribution.type === 'connector' &&
        !contributionByKey.has(`identity\0${contribution.identityRef}`)
      ) {
        return semanticError(
          `/contributions/${index}/identityRef`,
          '#/$defs/ConnectorContribution/declaredIdentityReference',
          'declaredIdentityReference',
          'connector identityRef must reference a declared identity contribution',
        );
      }
      if (contribution.type === 'ui' && contribution.kind === 'slot-item') {
        const command = contributionByKey.get(`ui\0${contribution.command}`);
        if (command?.type !== 'ui' || command.kind !== 'command') {
          return semanticError(
            `/contributions/${index}/command`,
            '#/$defs/UiSlotItemContribution/declaredCommandReference',
            'declaredCommandReference',
            'UI slot command must reference a declared UI command contribution',
          );
        }
      }
    }

    const referenceOwners = new Map<string, string>();
    for (const [featureIndex, feature] of manifest.features.entries()) {
      for (const [contributionIndex, reference] of (feature.contributions ?? []).entries()) {
        const key = `${reference.type}\0${reference.id}`;
        if (!contributionByKey.has(key)) {
          return semanticError(
            `/features/${featureIndex}/contributions/${contributionIndex}`,
            '#/$defs/ContributionReference/declaredContribution',
            'declaredContribution',
            'feature contribution must reference a declared contribution with the same type and id',
          );
        }
        const existingOwner = referenceOwners.get(key);
        if (existingOwner !== undefined) {
          return semanticError(
            `/features/${featureIndex}/contributions/${contributionIndex}`,
            '#/$defs/ContributionReference/singleFeatureOwner',
            'singleFeatureOwner',
            `a static contribution must have exactly one feature reference; already owned by ${existingOwner}`,
          );
        }
        referenceOwners.set(key, feature.id);
      }
    }

    for (const [key, contribution] of contributionByKey) {
      if (!referenceOwners.has(key)) {
        const index = contributions.indexOf(contribution);
        return semanticError(
          `/contributions/${index}`,
          '#/$defs/StaticContribution/featureOwnerRequired',
          'featureOwnerRequired',
          'every static contribution must be owned by one feature resource reference',
        );
      }
    }
    return {
      valid: true,
      manifest,
      errors: [],
    };
  }

  return {
    valid: false,
    errors: (validateSchema.errors ?? []).map((error) => ({
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      message: error.message ?? 'manifest validation failed',
    })),
  };
}
