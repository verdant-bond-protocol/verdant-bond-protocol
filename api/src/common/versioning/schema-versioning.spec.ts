/**
 * Schema versioning and compatibility layer tests.
 *
 * Tests cover legacy record reads, new writes, and unsupported versions.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/276
 */

import {
  SchemaVersion,
  createVersionedRecord,
  createSchemaMetadata,
  isVersionSupported,
  needsMigration,
  applyReadTransforms,
  applyWriteTransforms,
  validateRecordSchema,
  checkCompatibility,
  bondSchemaTransforms,
} from './schema-versioning';

describe('Schema Versioning Compatibility Layer (#276)', () => {
  describe('SchemaVersion enum', () => {
    it('defines all supported versions', () => {
      expect(isVersionSupported(SchemaVersion.V1_0_0)).toBe(true);
      expect(isVersionSupported(SchemaVersion.V1_1_0)).toBe(true);
      expect(isVersionSupported(SchemaVersion.V1_2_0)).toBe(true);
      expect(isVersionSupported(SchemaVersion.V2_0_0)).toBe(true);
    });
  });

  describe('isVersionSupported', () => {
    it('returns true for supported versions', () => {
      expect(isVersionSupported(SchemaVersion.V1_0_0)).toBe(true);
      expect(isVersionSupported(SchemaVersion.V2_0_0)).toBe(true);
    });
  });

  describe('needsMigration', () => {
    it('returns true when migrating from older version', () => {
      expect(needsMigration(SchemaVersion.V1_0_0, SchemaVersion.V2_0_0)).toBe(true);
      expect(needsMigration(SchemaVersion.V1_1_0, SchemaVersion.V2_0_0)).toBe(true);
    });

    it('returns false when already at target version', () => {
      expect(needsMigration(SchemaVersion.V2_0_0, SchemaVersion.V2_0_0)).toBe(false);
    });

    it('returns false for unsupported versions', () => {
      expect(needsMigration('9.9.9' as SchemaVersion, SchemaVersion.V2_0_0)).toBe(false);
    });
  });

  describe('createVersionedRecord', () => {
    it('creates a versioned record with metadata', () => {
      const record = createVersionedRecord(
        { id: 1, faceValue: '1000' },
        SchemaVersion.V2_0_0,
      );
      expect(record.metadata.version).toBe(SchemaVersion.V2_0_0);
      expect(record.data).toEqual({ id: 1, faceValue: '1000' });
    });

    it('accepts custom metadata', () => {
      const record = createVersionedRecord(
        { id: 1 },
        SchemaVersion.V1_0_0,
        { migratedFrom: SchemaVersion.V1_0_0 },
      );
      expect(record.metadata.migratedFrom).toBe(SchemaVersion.V1_0_0);
    });
  });

  describe('createSchemaMetadata', () => {
    it('creates schema metadata with defaults', () => {
      const metadata = createSchemaMetadata(SchemaVersion.V1_0_0);
      expect(metadata.version).toBe(SchemaVersion.V1_0_0);
      expect(metadata.migratedAt).toBeDefined();
    });

    it('accepts overrides', () => {
      const metadata = createSchemaMetadata(SchemaVersion.V2_0_0, { deprecated: true });
      expect(metadata.deprecated).toBe(true);
    });
  });

  describe('applyReadTransforms', () => {
    it('transforms V1_0_0 record to latest schema', () => {
      const v1Record = {
        id: 1,
        projectId: 'abc123',
        faceValue: '1000',
        couponSchedule: ['1000000', '2000000'],
        creditType: 'Carbon',
        maturityDate: 2000000000,
        totalSupply: '10000',
      };

      const result = applyReadTransforms<{
        id: number;
        projectRegistryId: string;
        faceValue: string;
        couponSchedule: string[];
        creditType: string;
        maturityDate: number;
        totalSupply: string;
        totalSubscribed: string;
        projectId: string;
        status: string;
        maturityStatus: string;
      }>(v1Record, SchemaVersion.V1_0_0, bondSchemaTransforms);

      expect(result.projectRegistryId).toBe('abc123');
      expect(result.totalSubscribed).toBe('0');
      expect(result.status).toBe('Active');
      expect(result.maturityStatus).toBe('Active');
    });

    it('transforms V1_2_0 record to latest schema', () => {
      const v12Record = {
        id: 2,
        projectId: 'def456',
        faceValue: '5000',
        couponSchedule: ['1000000'],
        maturityDate: 2000000000,
        totalSupply: '5000',
      };

      const result = applyReadTransforms<Record<string, any>>(v12Record, SchemaVersion.V1_2_0, bondSchemaTransforms);
      expect(result.projectRegistryId).toBe('def456');
      expect(result.status).toBe('Active');
    });
  });

  describe('applyWriteTransforms', () => {
    it('transforms latest record to V1_0_0 schema', () => {
      const latestRecord = {
        id: 1,
        projectRegistryId: 'abc123',
        faceValue: '1000',
        couponSchedule: ['1000000'],
        creditType: 'Carbon',
        maturityDate: 2000000000,
        totalSupply: '10000',
        totalSubscribed: '5000',
        status: 'Active',
        maturityStatus: 'Active',
      };

      const result = applyWriteTransforms<Record<string, any>>(latestRecord, SchemaVersion.V1_0_0, bondSchemaTransforms);
      expect(result.projectId).toBe('abc123');
      expect(result.projectRegistryId).toBeUndefined();
    });

    it('transforms latest record to V1_1_0 schema', () => {
      const latestRecord = {
        id: 1,
        projectRegistryId: 'abc123',
        faceValue: '1000',
        couponSchedule: ['1000000'],
        creditType: 'Carbon',
        maturityDate: 2000000000,
        totalSupply: '10000',
        totalSubscribed: '5000',
        status: 'Active',
        maturityStatus: 'Active',
      };

      const result = applyWriteTransforms<Record<string, any>>(latestRecord, SchemaVersion.V1_1_0, bondSchemaTransforms);
      expect(result.projectId).toBe('abc123');
      expect(result.projectRegistryId).toBeUndefined();
    });
  });

  describe('validateRecordSchema', () => {
    it('validates a record with correct metadata', () => {
      const record = createVersionedRecord({ id: 1 }, SchemaVersion.V2_0_0);
      const result = validateRecordSchema(record);
      expect(result.supported).toBe(true);
    });

    it('rejects a record missing metadata', () => {
      const result = validateRecordSchema({ data: { id: 1 } });
      expect(result.supported).toBe(false);
      expect(result.message).toContain('missing schema metadata');
    });

    it('rejects an unsupported version', () => {
      const record = createVersionedRecord(
        { id: 1 },
        '9.9.9' as SchemaVersion,
      );
      const result = validateRecordSchema(record);
      expect(result.supported).toBe(false);
      expect(result.message).toContain('not supported');
    });
  });

  describe('checkCompatibility', () => {
    it('confirms compatibility between supported versions', () => {
      const result = checkCompatibility(SchemaVersion.V1_0_0, SchemaVersion.V2_0_0);
      expect(result.supported).toBe(true);
    });

    it('rejects unsupported source version', () => {
      const result = checkCompatibility('9.9.9' as SchemaVersion, SchemaVersion.V2_0_0);
      expect(result.supported).toBe(false);
    });

    it('rejects unsupported target version', () => {
      const result = checkCompatibility(SchemaVersion.V2_0_0, '9.9.9' as SchemaVersion);
      expect(result.supported).toBe(false);
    });
  });

  describe('Legacy record reads', () => {
    it('can read a V1_0_0 bond record and transform to latest', () => {
      const v1Bond = {
        id: 1,
        projectId: 'a1b2',
        faceValue: '1000',
        couponSchedule: ['1000000', '2000000'],
        creditType: 'Carbon',
        maturityDate: 3000000,
        totalSupply: '10000',
      };

      const record = createVersionedRecord(v1Bond, SchemaVersion.V1_0_0);
      const result = validateRecordSchema(record);
      expect(result.supported).toBe(true);

      const transformed = applyReadTransforms<Record<string, any>>(record.data, record.metadata.version, bondSchemaTransforms);
      expect(transformed.totalSubscribed).toBe('0');
      expect(transformed.projectRegistryId).toBe('a1b2');
    });
  });

  describe('New writes', () => {
    it('can write a V2_0_0 record', () => {
      const v2Bond = {
        id: 2,
        projectRegistryId: 'new-project',
        faceValue: '5000',
        couponSchedule: ['1000000'],
        creditType: 'Biodiversity',
        maturityDate: 2500000000,
        totalSupply: '5000',
        totalSubscribed: '2000',
        status: 'Active',
        maturityStatus: 'Active',
      };

      const record = createVersionedRecord(v2Bond, SchemaVersion.V2_0_0);
      expect(record.metadata.version).toBe(SchemaVersion.V2_0_0);
      expect(record.data).toEqual(v2Bond);
    });
  });

  describe('Unsupported versions', () => {
    it('rejects records with unsupported versions', () => {
      const record = createVersionedRecord(
        { id: 1 },
        '9.9.9' as SchemaVersion,
      );
      const result = validateRecordSchema(record);
      expect(result.supported).toBe(false);
    });
  });
});
