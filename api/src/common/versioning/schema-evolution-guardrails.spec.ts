import {
  BOND_ENTITY_SCHEMA,
  SchemaEvolutionGuardrails,
  SchemaEvolutionError,
} from './schema-evolution-guardrails';
import { SchemaVersion } from './schema-versioning';

describe('Schema Evolution Guardrails (#354)', () => {
  const validV2 = {
    id: 'bond-2026-001',
    symbol: 'VBD-AMAZON-01',
    faceValue: '5000000',
    interestRate: 0.055,
    creditType: 'Carbon',
    projectRegistryId: 'PROJ-REG-AMAZON-01',
    status: 'Active',
  };

  it('validates canonical V2.0.0 record and sets default values', () => {
    const res = SchemaEvolutionGuardrails.processIngress(validV2, BOND_ENTITY_SCHEMA);
    expect(res.version).toBe(SchemaVersion.V2_0_0);
    expect(res.processedData.totalSubscribed).toBe('0');
    expect(res.strippedFields).toHaveLength(0);
  });

  it('transforms deprecated fields and issues deprecation warnings', () => {
    const legacy = {
      id: 'bond-legacy-002',
      symbol: 'VBD-LEGACY',
      faceValue: '1000000',
      legacyCouponRate: 550,
      projectId: 'PROJ-LEGACY-42',
      status: 'Active',
    };

    const res = SchemaEvolutionGuardrails.processIngress(legacy, BOND_ENTITY_SCHEMA);
    expect(res.processedData.projectRegistryId).toBe('PROJ-LEGACY-42');
    expect(res.processedData.interestRate).toBe(5.5);
    expect(res.processedData.projectId).toBeUndefined();
    expect(res.deprecationWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects unknown fields under REJECT policy', () => {
    const record = { ...validV2, rogueField: 12345 };
    expect(() =>
      SchemaEvolutionGuardrails.processIngress(record, BOND_ENTITY_SCHEMA, 'REJECT'),
    ).toThrow(expect.objectContaining({ code: 'unknown_field_rejected' }));
  });

  it('strips unknown fields under STRIP policy', () => {
    const record = { ...validV2, extraParam: 'sanitize_me' };
    const res = SchemaEvolutionGuardrails.processIngress(record, BOND_ENTITY_SCHEMA, 'STRIP');
    expect(res.processedData.extraParam).toBeUndefined();
    expect(res.strippedFields).toContain('extraParam');
  });

  it('isolates unknown fields into extensions under PRESERVE_EXTENSION policy', () => {
    const record = { ...validV2, customTag: 'special_value' };
    const res = SchemaEvolutionGuardrails.processIngress(record, BOND_ENTITY_SCHEMA, 'PRESERVE_EXTENSION');
    expect(res.processedData.extensions).toEqual({ customTag: 'special_value' });
  });

  it('verifies bi-directional backward and forward compatibility', () => {
    const legacy = {
      id: 'bond-legacy-002',
      symbol: 'VBD-LEGACY',
      faceValue: '1000000',
      interestRate: 0.05,
      projectId: 'PROJ-LEGACY-42',
      status: 'Active',
    };

    const compat = SchemaEvolutionGuardrails.verifyCompatibility(
      legacy,
      SchemaVersion.V1_0_0,
      BOND_ENTITY_SCHEMA,
    );

    expect(compat.backwardCompatible).toBe(true);
    expect(compat.forwardCompatible).toBe(true);
  });
});
