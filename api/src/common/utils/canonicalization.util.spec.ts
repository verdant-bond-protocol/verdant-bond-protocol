/**
 * Tests for Canonical Input Normalization
 * Closes #274
 */

import {
  canonicalize,
  canonicalizeBondData,
  canonicalizeInvestorData,
  canonicalizeSettlementData,
  areCanonicallyEqual,
  normalizeLegacyData,
} from './canonicalization.util';

describe('Canonicalization Utility', () => {
  describe('canonicalize', () => {
    it('should handle key ordering consistently', () => {
      const obj1 = { b: 2, a: 1, c: 3 };
      const obj2 = { c: 3, a: 1, b: 2 };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should normalize whitespace', () => {
      const obj1 = { name: '  Green   Bond  ' };
      const obj2 = { name: 'Green Bond' };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should normalize string casing', () => {
      const obj1 = { type: 'SUSTAINABILITY' };
      const obj2 = { type: 'sustainability' };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should handle numeric precision', () => {
      const obj1 = { amount: 1000.123456789 };
      const obj2 = { amount: 1000.12345679 };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should handle nested objects', () => {
      const obj1 = {
        bond: { id: '123', issuer: { name: '  Issuer  ' } },
      };
      const obj2 = {
        bond: { issuer: { name: 'Issuer' }, id: '123' },
      };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should handle arrays consistently', () => {
      const obj1 = { items: [1, 2, 3] };
      const obj2 = { items: [1, 2, 3] };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should handle Date objects', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');
      const obj1 = { date };
      const obj2 = { date: new Date('2024-01-01T00:00:00.000Z') };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should skip undefined values', () => {
      const obj1 = { a: 1, b: undefined, c: 3 };
      const obj2 = { a: 1, c: 3 };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should handle null values', () => {
      const obj1 = { value: null };
      const obj2 = { value: null };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should reject NaN and Infinity', () => {
      expect(() => canonicalize({ value: NaN })).toThrow();
      expect(() => canonicalize({ value: Infinity })).toThrow();
    });
  });

  describe('canonicalizeBondData', () => {
    it('should normalize bond data consistently', () => {
      const bond1 = {
        bondId: 'bond-123',
        amount: 1000000.123456789,
        type: 'GREEN',
        issuer: '  Sustainability Corp  ',
      };
      const bond2 = {
        issuer: 'Sustainability Corp',
        type: 'green',
        bondId: 'bond-123',
        amount: 1000000.12345679,
      };
      expect(canonicalizeBondData(bond1)).toBe(canonicalizeBondData(bond2));
    });
  });

  describe('canonicalizeInvestorData', () => {
    it('should preserve address casing', () => {
      const investor1 = { address: 'GDHX...ABC' };
      const investor2 = { address: 'gdhx...abc' };
      expect(canonicalizeInvestorData(investor1)).not.toBe(
        canonicalizeInvestorData(investor2),
      );
    });
  });

  describe('canonicalizeSettlementData', () => {
    it('should use 7 decimal precision for Stellar', () => {
      const settlement1 = { amount: 1000.12345678 };
      const settlement2 = { amount: 1000.1234568 };
      expect(canonicalizeSettlementData(settlement1)).toBe(
        canonicalizeSettlementData(settlement2),
      );
    });

    it('should preserve Stellar address casing', () => {
      const settlement1 = { destination: 'GDHX...ABC' };
      const settlement2 = { destination: 'gdhx...abc' };
      expect(canonicalizeSettlementData(settlement1)).not.toBe(
        canonicalizeSettlementData(settlement2),
      );
    });
  });

  describe('areCanonicallyEqual', () => {
    it('should correctly identify equivalent objects', () => {
      const obj1 = { b: 2, a: 1 };
      const obj2 = { a: 1, b: 2 };
      expect(areCanonicallyEqual(obj1, obj2)).toBe(true);
    });

    it('should correctly identify different objects', () => {
      const obj1 = { a: 1, b: 2 };
      const obj2 = { a: 1, b: 3 };
      expect(areCanonicallyEqual(obj1, obj2)).toBe(false);
    });
  });

  describe('normalizeLegacyData', () => {
    it('should transform legacy field names', () => {
      const legacy = {
        bondId: '123',
        issuerId: '456',
        bondAmount: 1000,
      };
      const normalized = normalizeLegacyData(legacy);
      expect(normalized).toEqual({
        bond_id: '123',
        issuer_id: '456',
        bond_amount: 1000,
      });
    });

    it('should handle nested legacy structures', () => {
      const legacy = {
        bond: {
          bondId: '123',
          issueDate: '2024-01-01',
        },
      };
      const normalized = normalizeLegacyData(legacy);
      expect(normalized).toEqual({
        bond: {
          bond_id: '123',
          issue_date: '2024-01-01',
        },
      });
    });
  });
});
