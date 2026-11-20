import { ChangeDetectionStrategy, Component, LOCALE_ID, computed, inject, input } from '@angular/core';
import { CREDIT_UNITS, CreditType } from '../../utils/credit-units';
import { formatCreditQuantity } from '../../utils/credit-quantity';

/**
 * Renders a credit quantity for sighted and screen-reader users from ONE
 * formatting result (#210). Both texts carry the same localised digits, so the
 * announced value can never differ from the visible one; only unit symbols such
 * as "tCO₂e", which screen readers read letter by letter, are spelled out.
 */
@Component({
  selector: 'app-credit-quantity',
  standalone: true,
  template: `<span aria-hidden="true">{{ formatted().text }}</span><span class="sr-only">{{ formatted().spoken }}</span>`,
  styles: [`
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditQuantityComponent {
  readonly amount = input.required<string | number | bigint>();
  readonly creditType = input.required<CreditType>();

  private readonly locale = inject(LOCALE_ID);
  private readonly units = inject(CREDIT_UNITS);

  readonly formatted = computed(() =>
    formatCreditQuantity(this.amount(), this.units[this.creditType()], this.locale),
  );
}
