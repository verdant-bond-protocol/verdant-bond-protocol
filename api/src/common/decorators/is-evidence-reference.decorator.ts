import { registerDecorator, ValidationOptions } from 'class-validator';
import { isValidCid } from '../utils';

/**
 * Validates that a field is a supported oracle evidence reference -- a
 * CIDv0 or a raw 64-character hex SHA-256 digest (issue #93). See
 * `cid.util.ts`'s module doc comment for exactly which formats are
 * supported and why. Malformed digest length, invalid encoding, and
 * unsupported CID versions are all rejected here, before the request ever
 * reaches a controller or service method.
 */
export function IsEvidenceReference(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isEvidenceReference',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && isValidCid(value);
        },
        defaultMessage: () =>
          'Invalid evidence reference: must be a valid CIDv0 (e.g. "Qm...") ' +
          'or a 64-character hex SHA-256 digest',
      },
    });
  };
}
