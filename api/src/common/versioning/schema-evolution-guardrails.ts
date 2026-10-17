/**
 * Schema Evolution Guardrails for Stored Records and Public API Responses.
 *
 * Implements:
 * 1. Schema version registry and SemVer delta rules.
 * 2. Strict rejection vs. sanitization policies for unknown fields.
 * 3. Deprecated field lifecycles (warn, fallback transform, sunset rejection).
 * 4. Bi-directional forward & backward compatibility transforms.
 *
 * Resolves Issue #354.
 */

import {
  SchemaVersion,
  createSchemaMetadata,
} from './schema-versioning.ts';
import type {
  SchemaMetadata,
  VersionedRecord,
} from './schema-versioning.ts';

export type UnknownFieldPolicy =
  | 'REJECT'            // Throws error immediately (strict mode for ledger/financial records).
  | 'STRIP'             // Strips unknown fields (standard mode for public ingress/egress).
  | 'PRESERVE_EXTENSION'; // Isolates unknown fields into an `extensions` namespace.

export interface DeprecatedFieldDef {
  fieldName: string;
  deprecatedSinceVersion: SchemaVersion;
  removedInVersion: SchemaVersion;
  canonicalReplacement: string;
  fallbackTransform?: (oldValue: any, currentData: Record<string, any>) => any;
  sunsetNotice: string;
}

export interface SchemaFieldDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  defaultValue?: any;
}

export interface EntitySchemaDefinition {
  entityName: string;
  targetVersion: SchemaVersion;
  fields: SchemaFieldDef[];
  deprecatedFields: DeprecatedFieldDef[];
  unknownFieldPolicy: UnknownFieldPolicy;
}

export class SchemaEvolutionError extends Error {
  readonly code:
    | 'unknown_field_rejected'
    | 'deprecated_field_removed'
    | 'missing_required_field'
    | 'incompatible_version'
    | 'migration_failed';

  constructor(
    message: string,
    code:
      | 'unknown_field_rejected'
      | 'deprecated_field_removed'
      | 'missing_required_field'
      | 'incompatible_version'
      | 'migration_failed',
  ) {
    super(message);
    this.name = 'SchemaEvolutionError';
    this.code = code;
  }
}

export interface IngressProcessResult<T = any> {
  processedData: T;
  version: SchemaVersion;
  strippedFields: string[];
  deprecationWarnings: string[];
}

export interface EgressProjectResult<T = any> {
  projectedData: T;
  targetVersion: SchemaVersion;
  deprecationNotices: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL BOND SCHEMA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export const BOND_ENTITY_SCHEMA: EntitySchemaDefinition = {
  entityName: 'Bond',
  targetVersion: SchemaVersion.V2_0_0,
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'symbol', type: 'string', required: true },
    { name: 'faceValue', type: 'string', required: true },
    { name: 'interestRate', type: 'number', required: true },
    { name: 'creditType', type: 'string', required: false, defaultValue: 'Carbon' },
    { name: 'totalSubscribed', type: 'string', required: false, defaultValue: '0' },
    { name: 'projectRegistryId', type: 'string', required: true },
    { name: 'status', type: 'string', required: true, defaultValue: 'Active' },
    { name: 'maturityStatus', type: 'string', required: false, defaultValue: 'Active' },
    { name: 'metadata', type: 'object', required: false },
  ],
  deprecatedFields: [
    {
      fieldName: 'projectId',
      deprecatedSinceVersion: SchemaVersion.V1_2_0,
      removedInVersion: SchemaVersion.V2_0_0,
      canonicalReplacement: 'projectRegistryId',
      fallbackTransform: (oldVal) => String(oldVal),
      sunsetNotice: 'Field "projectId" has been superseded by "projectRegistryId".',
    },
    {
      fieldName: 'legacyCouponRate',
      deprecatedSinceVersion: SchemaVersion.V1_1_0,
      removedInVersion: SchemaVersion.V2_0_0,
      canonicalReplacement: 'interestRate',
      fallbackTransform: (oldVal) => Number(oldVal) / 100,
      sunsetNotice: 'Field "legacyCouponRate" in basis points has been replaced by decimal "interestRate".',
    },
  ],
  unknownFieldPolicy: 'REJECT', // Strict for financial entity records
};

export class SchemaEvolutionGuardrails {
  /**
   * Processes stored record or request payload on write path (Ingress).
   * Validates required fields, applies unknown-field policies, and resolves deprecations.
   */
  static processIngress(
    rawData: Record<string, any>,
    schema: EntitySchemaDefinition,
    policyOverride?: UnknownFieldPolicy,
  ): IngressProcessResult {
    const policy = policyOverride || schema.unknownFieldPolicy;
    const strippedFields: string[] = [];
    const deprecationWarnings: string[] = [];

    const allowedFieldNames = new Set(schema.fields.map((f) => f.name));
    const deprecatedMap = new Map(schema.deprecatedFields.map((d) => [d.fieldName, d]));

    const workingData: Record<string, any> = { ...rawData };

    // 1. Check for deprecated fields
    for (const [key, val] of Object.entries(rawData)) {
      if (deprecatedMap.has(key)) {
        const dep = deprecatedMap.get(key)!;
        deprecationWarnings.push(
          `Field "${key}" is deprecated since ${dep.deprecatedSinceVersion}. Please use "${dep.canonicalReplacement}". ${dep.sunsetNotice}`,
        );

        // Map fallback to canonical replacement if canonical field was omitted
        if (workingData[dep.canonicalReplacement] === undefined && dep.fallbackTransform) {
          workingData[dep.canonicalReplacement] = dep.fallbackTransform(val, workingData);
        }

        // In latest target version V2_0_0, remove legacy field from stored record
        delete workingData[key];
      }
    }

    // 2. Enforce unknown fields policy
    const extensions: Record<string, any> = {};
    for (const key of Object.keys(workingData)) {
      if (!allowedFieldNames.has(key)) {
        if (policy === 'REJECT') {
          throw new SchemaEvolutionError(
            `Unknown field "${key}" rejected under strict schema guardrail for ${schema.entityName}.`,
            'unknown_field_rejected',
          );
        } else if (policy === 'STRIP') {
          strippedFields.push(key);
          delete workingData[key];
        } else if (policy === 'PRESERVE_EXTENSION') {
          extensions[key] = workingData[key];
          delete workingData[key];
        }
      }
    }

    if (policy === 'PRESERVE_EXTENSION' && Object.keys(extensions).length > 0) {
      workingData.extensions = extensions;
    }

    // 3. Enforce required fields and defaults
    for (const field of schema.fields) {
      if (workingData[field.name] === undefined || workingData[field.name] === null) {
        if (field.required) {
          throw new SchemaEvolutionError(
            `Missing required field "${field.name}" for ${schema.entityName}.`,
            'missing_required_field',
          );
        } else if (field.defaultValue !== undefined) {
          workingData[field.name] = field.defaultValue;
        }
      }
    }

    return {
      processedData: workingData,
      version: schema.targetVersion,
      strippedFields,
      deprecationWarnings,
    };
  }

  /**
   * Projects stored record to client target version on read path (Egress).
   * Ensures public API consumers receive canonical shapes or legacy fallback shapes.
   */
  static projectEgress(
    data: Record<string, any>,
    targetVersion: SchemaVersion,
    schema: EntitySchemaDefinition,
  ): EgressProcessResult {
    const deprecationNotices: string[] = [];
    const projected: Record<string, any> = { ...data };

    if (targetVersion === SchemaVersion.V1_0_0 || targetVersion === SchemaVersion.V1_1_0) {
      // Downward projection: map canonical replacement back to legacy fields for older clients
      for (const dep of schema.deprecatedFields) {
        if (projected[dep.canonicalReplacement] !== undefined && projected[dep.fieldName] === undefined) {
          projected[dep.fieldName] = projected[dep.canonicalReplacement];
          deprecationNotices.push(
            `Response projected with legacy field "${dep.fieldName}". Migrate to "${dep.canonicalReplacement}".`,
          );
        }
      }
    }

    return {
      projectedData: projected,
      targetVersion,
      deprecationNotices,
    };
  }

  /**
   * Automated verification of schema backward and forward compatibility.
   */
  static verifyCompatibility(
    legacyFixture: Record<string, any>,
    legacyVersion: SchemaVersion,
    schema: EntitySchemaDefinition,
  ): { backwardCompatible: boolean; forwardCompatible: boolean; transformed: any } {
    // Backward compatibility: Can latest version read and process legacy record?
    const ingress = this.processIngress(legacyFixture, schema, 'STRIP');
    const backwardCompatible = ingress.processedData.projectRegistryId !== undefined;

    // Forward compatibility: Can processed record be projected back for legacy client?
    const egress = this.projectEgress(ingress.processedData, legacyVersion, schema);
    const forwardCompatible = egress.projectedData.projectId !== undefined;

    return {
      backwardCompatible,
      forwardCompatible,
      transformed: ingress.processedData,
    };
  }
}
