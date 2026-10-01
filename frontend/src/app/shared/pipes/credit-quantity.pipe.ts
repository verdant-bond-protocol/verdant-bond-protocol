import { LOCALE_ID, Pipe, PipeTransform, inject } from '@angular/core';
import { CREDIT_UNITS, CreditType } from '../utils/credit-units';
import { formatCreditQuantity } from '../utils/credit-quantity';

/**
 * `{{ minorUnits | creditQuantity: creditType }}` → "1,234.5 carbon credits (tCO₂e)"
 * in the app locale (#210). Precision and names come from `CREDIT_UNITS`.
 * For screen-reader-safe output use `<app-credit-quantity>`, which pairs this
 * text with a spoken form carrying identical digits.
 */
@Pipe({ name: 'creditQuantity', standalone: true })
export class CreditQuantityPipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);
  private readonly units = inject(CREDIT_UNITS);

  transform(minorUnits: string | number | bigint | null | undefined, creditType: CreditType): string {
    return formatCreditQuantity(minorUnits ?? 0, this.units[creditType], this.locale).text;
  }
}
