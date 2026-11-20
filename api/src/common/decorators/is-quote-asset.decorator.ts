import { registerDecorator, ValidationOptions } from 'class-validator';
import { isSupportedQuoteAssetSymbol, QUOTE_ASSET_REGISTRY } from '../../marketplace/quote-assets';

/**
 * Validates a field against the canonical quote asset registry (issue #92),
 * replacing the hardcoded `@IsEnum(['USDC', 'XLM'])` that used to be
 * duplicated across every marketplace DTO. Case-insensitive — combine with
 * `@Transform` in the DTO if you want the normalized value to also land in
 * the transformed instance before the service layer sees it.
 */
export function IsQuoteAssetSymbol(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isQuoteAssetSymbol',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && isSupportedQuoteAssetSymbol(value);
        },
        defaultMessage: () =>
          `Unsupported quote asset. Supported: ${QUOTE_ASSET_REGISTRY.filter((a) => a.enabled)
            .map((a) => a.symbol)
            .join(', ')}.`,
      },
    });
  };
}
