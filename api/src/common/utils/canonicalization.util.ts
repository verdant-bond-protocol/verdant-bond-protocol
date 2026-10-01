/**
 * Canonical Input Normalization Utility
 * 
 * Ensures that equivalent data produces identical canonical representations
 * for signing, hashing, comparison, and settlement operations.
 * 
 * Closes #274
 */

export interface CanonicalOptions {
  sortKeys?: boolean;
  trimStrings?: boolean;
  normalizeCase?: 'lower' | 'upper' | 'none';
  precision?: number; // for numeric values
  stripWhitespace?: boolean;
}

const DEFAULT_OPTIONS: CanonicalOptions = {
  sortKeys: true,
  trimStrings: true,
  normalizeCase: 'lower',
  precision: 8,
  stripWhitespace: true,
};

/**
 * Canonicalizes an object for consistent hashing/signing
 */
export function canonicalize(
  input: any,
  options: CanonicalOptions = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  function canonicalizeValue(value: any): any {
    // Handle null and undefined
    if (value === null || value === undefined) {
      return null;
    }

    // Handle Date objects
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle numbers with precision
    if (typeof value === 'number') {
      if (!isFinite(value)) {
        throw new Error('Cannot canonicalize Infinity or NaN');
      }
      return opts.precision !== undefined
        ? parseFloat(value.toFixed(opts.precision))
        : value;
    }

    // Handle strings
    if (typeof value === 'string') {
      let str = value;
      if (opts.trimStrings) {
        str = str.trim();
      }
      if (opts.stripWhitespace) {
        str = str.replace(/\s+/g, ' ');
      }
      if (opts.normalizeCase === 'lower') {
        str = str.toLowerCase();
      } else if (opts.normalizeCase === 'upper') {
        str = str.toUpperCase();
      }
      return str;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeValue(item));
    }

    // Handle objects
    if (typeof value === 'object') {
      const keys = opts.sortKeys
        ? Object.keys(value).sort()
        : Object.keys(value);

      const result: any = {};
      for (const key of keys) {
        // Skip undefined values
        if (value[key] !== undefined) {
          result[key] = canonicalizeValue(value[key]);
        }
      }
      return result;
    }

    // Handle booleans and other primitives
    return value;
  }

  const canonicalValue = canonicalizeValue(input);
  return JSON.stringify(canonicalValue);
}

/**
 * Normalizes bond data for signing/verification
 */
export function canonicalizeBondData(bondData: any): string {
  return canonicalize(bondData, {
    sortKeys: true,
    trimStrings: true,
    normalizeCase: 'lower',
    precision: 8,
    stripWhitespace: true,
  });
}

/**
 * Normalizes investor data for consistency
 */
export function canonicalizeInvestorData(investorData: any): string {
  // Preserve case for addresses and identifiers
  return canonicalize(investorData, {
    sortKeys: true,
    trimStrings: true,
    normalizeCase: 'none',
    precision: 8,
    stripWhitespace: true,
  });
}

/**
 * Normalizes settlement data for Stellar operations
 */
export function canonicalizeSettlementData(settlementData: any): string {
  return canonicalize(settlementData, {
    sortKeys: true,
    trimStrings: true,
    normalizeCase: 'none', // Preserve Stellar address casing
    precision: 7, // Stellar uses 7 decimal places
    stripWhitespace: true,
  });
}

/**
 * Validates if two objects are canonically equivalent
 */
export function areCanonicallyEqual(obj1: any, obj2: any): boolean {
  const canonical1 = canonicalize(obj1);
  const canonical2 = canonicalize(obj2);
  return canonical1 === canonical2;
}

/**
 * Handles legacy data format compatibility
 */
export function normalizeLegacyData(legacyData: any): any {
  // Convert old field names to new canonical format
  const fieldMappings: Record<string, string> = {
    bondId: 'bond_id',
    issuerId: 'issuer_id',
    investorId: 'investor_id',
    bondAmount: 'bond_amount',
    issueDate: 'issue_date',
  };

  function transformKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(transformKeys);
    }

    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = fieldMappings[key] || key;
      result[newKey] = transformKeys(value);
    }
    return result;
  }

  return transformKeys(legacyData);
}
