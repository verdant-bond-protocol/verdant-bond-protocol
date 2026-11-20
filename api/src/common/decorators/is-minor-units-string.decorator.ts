import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';
import { I128_MAX, MAX_MINOR_UNITS_STRING_LENGTH, parseMinorUnits } from '../utils/bigint.util';

/**
 * Validates a large-integer financial amount sent as a base-10 minor-unit
 * string (see `docs/large-integer-financial-values.md`).
 *
 * The `@Transform` restores the raw request value before validation. Without
 * it, the global `ValidationPipe`'s `enableImplicitConversion` would turn a
 * JSON number such as `12345678901234567891` — already rounded by
 * `JSON.parse` to `12345678901234567000` — into a perfectly valid-looking
 * digit string, silently pricing a different amount than the client meant.
 */
export function IsMinorUnitsString(validationOptions?: ValidationOptions) {
  return applyDecorators(
    Transform(({ obj, key }) => obj[key], { toClassOnly: true }),
    function (object: object, propertyName: string) {
      registerDecorator({
        name: 'isMinorUnitsString',
        target: object.constructor,
        propertyName,
        options: validationOptions,
        validator: {
          validate(value: unknown) {
            return parseMinorUnits(value) !== null;
          },
          defaultMessage: (args) =>
            `${args?.property ?? 'amount'} must be a base-10 integer string of at most ` +
            `${MAX_MINOR_UNITS_STRING_LENGTH} characters in [0, ${I128_MAX}] (JSON numbers are not accepted)`,
        },
      });
    },
  );
}
