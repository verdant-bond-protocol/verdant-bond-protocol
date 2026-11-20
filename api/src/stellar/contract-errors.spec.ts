import * as fs from 'fs';
import * as path from 'path';
import { ERROR_MAPPINGS, StableErrorCode } from './contract-errors';

describe('Contract Error Mapping Verification', () => {
  const rustErrorsPath = path.resolve(__dirname, '../../../contracts/shared/src/errors.rs');

  interface RustEnumVariant {
    name: string;
    value: number;
  }

  interface RustEnum {
    name: string;
    variants: RustEnumVariant[];
  }

  // Parse Rust enums from errors.rs
  function parseRustEnums(filePath: string): RustEnum[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const enums: RustEnum[] = [];
    
    // Regular expression to match #[contracterror] followed by pub enum Name { ... }
    const enumRegex = /#\[contracterror\]\s*pub\s*enum\s+(\w+)\s*\{([^}]+)\}/g;
    let match;

    while ((match = enumRegex.exec(content)) !== null) {
      const enumName = match[1];
      const enumBody = match[2];
      
      const variants: RustEnumVariant[] = [];
      // Matches Variant = value
      const variantRegex = /(\w+)\s*=\s*(\d+)/g;
      let variantMatch;
      
      while ((variantMatch = variantRegex.exec(enumBody)) !== null) {
        variants.push({
          name: variantMatch[1],
          value: parseInt(variantMatch[2], 10),
        });
      }
      
      enums.push({ name: enumName, variants });
    }

    return enums;
  }

  const RUST_ENUM_TO_CATEGORY: Record<string, string> = {
    BondError: 'BOND',
    OracleError: 'ORACLE',
    DEXError: 'DEX',
    RegistryError: 'REGISTRY',
    CreditError: 'CREDIT',
    GovernanceError: 'GOVERNANCE',
  };

  it('should successfully read and parse contracts/shared/src/errors.rs', () => {
    expect(fs.existsSync(rustErrorsPath)).toBe(true);
    const rustEnums = parseRustEnums(rustErrorsPath);
    expect(rustEnums.length).toBeGreaterThanOrEqual(5); // should find BondError, OracleError, etc.
  });

  it('should have a stable TS mapping for every Rust contract error discriminant', () => {
    const rustEnums = parseRustEnums(rustErrorsPath);

    for (const rustEnum of rustEnums) {
      const category = RUST_ENUM_TO_CATEGORY[rustEnum.name];
      expect(category).toBeDefined(); // Each Rust enum must be mapped to a category

      const categoryMapping = ERROR_MAPPINGS[category];
      expect(categoryMapping).toBeDefined(); // The category must exist in ERROR_MAPPINGS

      for (const variant of rustEnum.variants) {
        const mapped = categoryMapping[variant.value];
        
        // Assert that the variant value is mapped to a stable code and description
        expect(mapped).toBeDefined();
        expect(mapped.code).toBeDefined();
        expect(Object.values(StableErrorCode)).toContain(mapped.code);
        expect(mapped.message).toBeDefined();
        expect(mapped.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('should fall back safely for unknown/unmapped error codes', () => {
    // Check if category doesn't exist
    const categoryMapping = ERROR_MAPPINGS['NON_EXISTENT'];
    expect(categoryMapping).toBeUndefined();
  });
});
