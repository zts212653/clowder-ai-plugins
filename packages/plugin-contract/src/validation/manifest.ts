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

function requiredWhenScalarType(
  field: NonNullable<PluginManifest['configuration']>[number],
): 'string' | 'number' | 'boolean' | undefined {
  switch (field.kind) {
    case 'string':
    case 'secret':
    case 'select':
    case 'url':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'operation':
      return undefined;
  }
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

    for (const [index, field] of configuration.entries()) {
      if (field.requiredWhen === undefined) continue;

      const conditionField = configByKey.get(field.requiredWhen.key);
      if (conditionField === undefined) {
        return semanticError(
          `/configuration/${index}/requiredWhen/key`,
          '#/$defs/ConfigurationField/requiredWhenDeclaredKey',
          'requiredWhenDeclaredKey',
          'requiredWhen key must reference a declared configuration field',
        );
      }

      const scalarType = requiredWhenScalarType(conditionField);
      if (scalarType === undefined) {
        return semanticError(
          `/configuration/${index}/requiredWhen/key`,
          '#/$defs/ConfigurationField/requiredWhenScalarKey',
          'requiredWhenScalarKey',
          'requiredWhen key must reference a non-operation scalar configuration field',
        );
      }

      const conditionValues = Array.isArray(field.requiredWhen.value)
        ? field.requiredWhen.value
        : [field.requiredWhen.value];
      if (!conditionValues.every((value) => typeof value === scalarType)) {
        return semanticError(
          `/configuration/${index}/requiredWhen/value`,
          '#/$defs/ConfigurationField/requiredWhenCompatibleValue',
          'requiredWhenCompatibleValue',
          `requiredWhen value must match the referenced ${scalarType} configuration field`,
        );
      }
    }

    for (const [index, field] of configuration.entries()) {
      if (field.kind !== 'operation') continue;

      const actionIds = new Set<string>();
      for (const [actionIndex, action] of field.actions.entries()) {
        if (actionIds.has(action.id)) {
          return semanticError(
            `/configuration/${index}/actions/${actionIndex}/id`,
            '#/$defs/ActionDef/uniqueActionIds',
            'uniqueActionIds',
            'operation action id must be unique within the same operation',
          );
        }
        actionIds.add(action.id);
      }

      for (const [actionIndex, action] of field.actions.entries()) {
        for (const reference of ['next', 'rollback'] as const) {
          const target = action[reference];
          if (target !== undefined && !actionIds.has(target)) {
            return semanticError(
              `/configuration/${index}/actions/${actionIndex}/${reference}`,
              `#/$defs/ActionDef/${reference}DeclaredByOperation`,
              `${reference}DeclaredByOperation`,
              `operation action ${reference} must reference an action in the same operation`,
            );
          }
        }
      }

      for (const [targetIndex, target] of (field.target ?? []).entries()) {
        const targetField = configByKey.get(target);
        if (targetField === undefined || targetField.kind === 'operation') {
          return semanticError(
            `/configuration/${index}/target/${targetIndex}`,
            '#/$defs/ConfigurationField/declaredValueTarget',
            'declaredValueTarget',
            'operation target must reference a declared non-operation configuration key',
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

    if (manifest.runtime === undefined) {
      const runtimeConfigurationIndex = configuration.findIndex(
        (field) => field.kind === 'operation',
      );
      if (runtimeConfigurationIndex !== -1) {
        const field = configuration[runtimeConfigurationIndex];
        return semanticError(
          `/configuration/${runtimeConfigurationIndex}`,
          '#/$defs/ConfigurationField/runtimeRequired',
          'runtimeRequired',
          `runtime is required by configuration ${field.key}`,
        );
      }
      if (manifest.test !== undefined) {
        return semanticError(
          '/test',
          '#/$defs/PluginTestDeclaration/runtimeRequired',
          'runtimeRequired',
          `runtime is required by test ${manifest.pluginId}`,
        );
      }
      const runtimeContributionIndex = contributions.findIndex(
        (contribution) =>
          'action' in contribution ||
          contribution.type === 'media-source' ||
          contribution.type === 'limb' ||
          contribution.type === 'connector' ||
          contribution.type === 'cloud-conversation-host',
      );
      if (runtimeContributionIndex !== -1) {
        const contribution = contributions[runtimeContributionIndex];
        return semanticError(
          `/contributions/${runtimeContributionIndex}`,
          '#/$defs/StaticContribution/runtimeRequired',
          'runtimeRequired',
          `runtime is required by contribution ${contribution.id}`,
        );
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
        if (reference.type === 'desktop-window' && !feature.capabilities.includes('windows.create')) {
          return semanticError(
            `/features/${featureIndex}/capabilities`,
            '#/$defs/DesktopWindowContribution/windowCapabilityRequired',
            'windowCapabilityRequired',
            'a desktop window must be owned by a feature that requests windows.create',
          );
        }
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

    for (const [index, contribution] of contributions.entries()) {
      const owner = referenceOwners.get(`${contribution.type}\0${contribution.id}`);
      if (contribution.type === 'connector') {
        const identityKey = `identity\0${contribution.identityRef}`;
        if (!contributionByKey.has(identityKey)) {
          return semanticError(
            `/contributions/${index}/identityRef`,
            '#/$defs/ConnectorContribution/declaredIdentityReference',
            'declaredIdentityReference',
            'connector identityRef must reference a declared identity contribution',
          );
        }
        if (referenceOwners.get(identityKey) !== owner) {
          return semanticError(
            `/contributions/${index}/identityRef`,
            '#/$defs/ConnectorContribution/sameFeatureOwner',
            'sameFeatureOwner',
            'connector identityRef must reference an identity owned by the same feature',
          );
        }
      }
      if (contribution.type === 'media-source') {
        const identityKey = `identity\0${contribution.binding}`;
        if (!contributionByKey.has(identityKey)) {
          return semanticError(
            `/contributions/${index}/binding`,
            '#/$defs/MediaSourceContribution/declaredIdentityBinding',
            'declaredIdentityBinding',
            'media-source binding must reference a declared identity contribution',
          );
        }
        if (referenceOwners.get(identityKey) !== owner) {
          return semanticError(
            `/contributions/${index}/binding`,
            '#/$defs/MediaSourceContribution/sameFeatureOwner',
            'sameFeatureOwner',
            'media-source binding must reference an identity owned by the same feature',
          );
        }
        const feature = manifest.features.find((candidate) => candidate.id === owner);
        if (
          feature === undefined ||
          !feature.capabilities.includes('plugin.state.get') ||
          !feature.capabilities.includes('plugin.state.set')
        ) {
          return semanticError(
            `/features/${manifest.features.indexOf(feature!)}/capabilities`,
            '#/$defs/MediaSourceContribution/stateCapabilitiesRequired',
            'stateCapabilitiesRequired',
            'media-source requires plugin.state.get and plugin.state.set for durable PMR retention',
          );
        }
      }
      if (contribution.type === 'cloud-conversation-host') {
        const feature = manifest.features.find((candidate) => candidate.id === owner);
        if (feature === undefined || !feature.capabilities.includes('cloud.conversation.host')) {
          return semanticError(
            `/features/${manifest.features.indexOf(feature!)}/capabilities`,
            '#/$defs/CloudConversationHostContribution/capabilityRequired',
            'capabilityRequired',
            'a cloud conversation host must be owned by a feature that requests cloud.conversation.host',
          );
        }
      }
      if (contribution.type === 'ui' && contribution.kind === 'slot-item') {
        const commandKey = `ui\0${contribution.command}`;
        const command = contributionByKey.get(commandKey);
        if (command?.type !== 'ui' || command.kind !== 'command') {
          return semanticError(
            `/contributions/${index}/command`,
            '#/$defs/UiSlotItemContribution/declaredCommandReference',
            'declaredCommandReference',
            'UI slot command must reference a declared UI command contribution',
          );
        }
        if (referenceOwners.get(commandKey) !== owner) {
          return semanticError(
            `/contributions/${index}/command`,
            '#/$defs/UiSlotItemContribution/sameFeatureOwner',
            'sameFeatureOwner',
            'UI slot command must reference a command owned by the same feature',
          );
        }
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
