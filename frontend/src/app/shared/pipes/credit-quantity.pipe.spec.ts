import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CreditQuantityPipe } from './credit-quantity.pipe';
import { CREDIT_UNITS, DEFAULT_CREDIT_UNITS } from '../utils/credit-units';

describe('CreditQuantityPipe (#210)', () => {
  const pipe = (locale: string, units = DEFAULT_CREDIT_UNITS) => {
    TestBed.configureTestingModule({
      providers: [CreditQuantityPipe, { provide: LOCALE_ID, useValue: locale }, { provide: CREDIT_UNITS, useValue: units }],
    });
    return TestBed.inject(CreditQuantityPipe);
  };

  it('formats in the app locale', () => {
    expect(pipe('de-DE').transform('2500000', 'Carbon')).toBe('2,5 carbon credits (tCO₂e)');
  });

  it('takes precision from the injected unit table, not from code', () => {
    const units = { ...DEFAULT_CREDIT_UNITS, Carbon: { ...DEFAULT_CREDIT_UNITS.Carbon, maxFractionDigits: 1 } };
    expect(pipe('en-US', units).transform('2567000', 'Carbon')).toBe('2.5 carbon credits (tCO₂e)');
  });

  it('renders a missing value as zero', () => {
    expect(pipe('en-US').transform(null, 'Basket')).toBe('0 basket credits');
  });
});
