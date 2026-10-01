/**
 * Schema versioning and compatibility layer for the Verdant Bond Protocol.
 *
 * Provides version metadata, compatibility transforms for read/write paths,
 * and support for legacy records.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/276
 */

/**
 * Schema versions supported by the protocol.
 */
export enum SchemaVersion {
  V1_0_0 = '1.0.0',
  V1_1_0 = '1.1.0',
  V1_2_0 = '1.2.0',
  V2_0_0 = '2.0.0',
}

/**
 * Metadata attached to every record to identify its schema version.
 */
export interface SchemaMetadata {
  version: SchemaVersion;
  migratedAt?: number;
  migratedFrom?: SchemaVersion;
  deprecated?: boolean;
}

/**
 * A versioned record wrapper.
 */
export interface VersionedRecord<T = any> {
  metadata: SchemaMetadata;
  data: T;
}

/**
 * Transform function that converts data between schema versions.
 */
export type SchemaTransform<T = any> = (data: any) => T;

/**
 * Compatibility transform for read paths.
 * Takes old-format data and transforms it to the latest schema shape.
 */
export interface ReadTransform<T = any> {
  fromVersion: SchemaVersion;
  transform: SchemaTransform<T>;
}

/**
 * Compatibility transform for write paths.
 * Takes data in the latest schema shape and transforms it to the target version.
 */
export interface WriteTransform<T = any> {
  toVersion: SchemaVersion;
  transform: SchemaTransform<T>;
}

/**
 * Registry of read and write transforms keyed by source/target version.
 */
export interface CompatibilityRegistry<T = any> {
  readTransforms: ReadTransform<T>[];
  writeTransforms: WriteTransform<T>[];
}

/**
 * Result of a compatibility check.
 */
export interface CompatibilityResult {
  supported: boolean;
  fromVersion: SchemaVersion;
  toVersion: SchemaVersion;
  message: string;
}

/**
 * Default schema metadata factory.
 */
export function createSchemaMetadata(
  version: SchemaVersion,
  overrides?: Partial<SchemaMetadata>,
): SchemaMetadata {
  return {
    version,
    migratedAt: overrides?.migratedAt ?? Date.now(),
    ...overrides,
  };
}

/**
 * Creates a versioned record with metadata.
 */
export function createVersionedRecord<T>(
  data: T,
  version: SchemaVersion = SchemaVersion.V2_0_0,
  metadata?: Partial<SchemaMetadata>,
): VersionedRecord<T> {
  return {
    metadata: createSchemaMetadata(version, metadata),
    data,
  };
}

/**
 * Checks if a version is supported by the protocol.
 */
export function isVersionSupported(version: SchemaVersion): boolean {
  const supported = [
    SchemaVersion.V1_0_0,
    SchemaVersion.V1_1_0,
    SchemaVersion.V1_2_0,
    SchemaVersion.V2_0_0,
  ];
  return supported.includes(version);
}

/**
 * Determines if a record needs migration from its current version to the target.
 */
export function needsMigration(
  recordVersion: SchemaVersion,
  targetVersion: SchemaVersion = SchemaVersion.V2_0_0,
): boolean {
  if (!isVersionSupported(recordVersion) || !isVersionSupported(targetVersion)) {
    return false;
  }
  const versionOrder = [SchemaVersion.V1_0_0, SchemaVersion.V1_1_0, SchemaVersion.V1_2_0, SchemaVersion.V2_0_0];
  return versionOrder.indexOf(recordVersion) < versionOrder.indexOf(targetVersion);
}

/**
 * Bond-specific schema transforms.
 *
 * V1_0_0: Original schema with basic bond fields.
 * V1_1_0: Added creditType and maturityStatus fields.
 * V1_2_0: Added totalSubscribed and updated couponSchedule format.
 * V2_0_0: Added projectRegistryId, unified maturityStatus, added status enum.
 */
export const bondSchemaTransforms: CompatibilityRegistry = {
  readTransforms: [
    {
      fromVersion: SchemaVersion.V1_0_0,
      transform: (data: any) => ({
        ...data,
        maturityStatus: data.maturityStatus || 'Active',
        creditType: data.creditType || 'Carbon',
        totalSubscribed: data.totalSubscribed || '0',
        projectRegistryId: data.projectId || '',
        status: data.status || 'Active',
      }),
    },
    {
      fromVersion: SchemaVersion.V1_1_0,
      transform: (data: any) => ({
        ...data,
        totalSubscribed: data.totalSubscribed || '0',
        projectRegistryId: data.projectId || '',
        status: data.status || 'Active',
      }),
    },
    {
      fromVersion: SchemaVersion.V1_2_0,
      transform: (data: any) => ({
        ...data,
        projectRegistryId: data.projectId || '',
        status: data.status || 'Active',
      }),
    },
  ],
  writeTransforms: [
    {
      toVersion: SchemaVersion.V1_0_0,
      transform: (data: any) => {
        const { maturityStatus, creditType, totalSubscribed, projectRegistryId, status, ...rest } = data;
        return { ...rest, projectId: projectRegistryId || '', faceValue: rest.faceValue };
      },
    },
    {
      toVersion: SchemaVersion.V1_1_0,
      transform: (data: any) => {
        const { maturityStatus, creditType, totalSubscribed, projectRegistryId, status, ...rest } = data;
        return { ...rest, projectId: projectRegistryId || '' };
      },
    },
    {
      toVersion: SchemaVersion.V1_2_0,
      transform: (data: any) => {
        const { projectRegistryId, status, ...rest } = data;
        return { ...rest, projectId: projectRegistryId || '' };
      },
    },
  ],
};

/**
 * Applies read transforms to convert old data to the latest schema.
 */
export function applyReadTransforms<T>(
  data: any,
  fromVersion: SchemaVersion,
  transforms: CompatibilityRegistry,
): T {
  const versionOrder = [SchemaVersion.V1_0_0, SchemaVersion.V1_1_0, SchemaVersion.V1_2_0, SchemaVersion.V2_0_0];
  let currentData = data;
  const fromIndex = versionOrder.indexOf(fromVersion);
  const toIndex = versionOrder.indexOf(SchemaVersion.V2_0_0);

  for (let i = fromIndex; i < toIndex; i++) {
    const fromVer = versionOrder[i];
    const transform = transforms.readTransforms.find((t) => t.fromVersion === fromVer);
    if (transform) {
      currentData = transform.transform(currentData);
    }
  }
  return currentData as T;
}

/**
 * Applies write transforms to convert data to a target version.
 */
export function applyWriteTransforms<T>(
  data: any,
  toVersion: SchemaVersion,
  transforms: CompatibilityRegistry,
): T {
  // Each write transform maps the latest shape directly to its target version,
  // so exactly one applies; chaining them would feed one version's output into
  // a transform that expects the latest shape. The latest version needs none.
  const transform = transforms.writeTransforms.find((t) => t.toVersion === toVersion);
  return (transform ? transform.transform(data) : data) as T;
}

/**
 * Validates that a record has valid schema metadata.
 */
export function validateRecordSchema(record: any): CompatibilityResult {
  if (!record || !record.metadata || !record.metadata.version) {
    return {
      supported: false,
      fromVersion: SchemaVersion.V1_0_0,
      toVersion: SchemaVersion.V2_0_0,
      message: 'Record is missing schema metadata',
    };
  }

  const version = record.metadata.version as SchemaVersion;
  if (!isVersionSupported(version)) {
    return {
      supported: false,
      fromVersion: version,
      toVersion: SchemaVersion.V2_0_0,
      message: `Schema version ${version} is not supported`,
    };
  }

  return {
    supported: true,
    fromVersion: version,
    toVersion: SchemaVersion.V2_0_0,
    message: `Record schema version ${version} is supported`,
  };
}

/**
 * Checks compatibility between two versions.
 */
export function checkCompatibility(
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion,
): CompatibilityResult {
  if (!isVersionSupported(fromVersion)) {
    return {
      supported: false,
      fromVersion,
      toVersion,
      message: `Source version ${fromVersion} is not supported`,
    };
  }
  if (!isVersionSupported(toVersion)) {
    return {
      supported: false,
      fromVersion,
      toVersion,
      message: `Target version ${toVersion} is not supported`,
    };
  }
  return {
    supported: true,
    fromVersion,
    toVersion,
    message: `Migration from ${fromVersion} to ${toVersion} is supported`,
  };
}
