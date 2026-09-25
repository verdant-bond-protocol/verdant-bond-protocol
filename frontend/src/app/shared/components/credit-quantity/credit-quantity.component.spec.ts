import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CreditQuantityComponent } from './credit-quantity.component';

describe('CreditQuantityComponent (#210)', () => {
  const render = (amount: string, locale = 'en-US') => {
    TestBed.configureTestingModule({
      imports: [CreditQuantityComponent],
      providers: [{ provide: LOCALE_ID, useValue: locale }],
    });
    const fixture = TestBed.createComponent(CreditQuantityComponent);
    fixture.componentRef.setInput('amount', amount);
    fixture.componentRef.setInput('creditType', 'Carbon');
    fixture.detectChanges();
    const [visible, spoken] = Array.from(fixture.nativeElement.querySelectorAll('span')) as HTMLElement[];
    return { visible, spoken };
  };

  it('hides the symbol-bearing text from screen readers and exposes a spoken twin', () => {
    const { visible, spoken } = render('1234500000');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.textContent).toBe('1,234.5 carbon credits (tCO₂e)');
    expect(spoken.textContent).toBe('1,234.5 carbon credits, in tonnes of CO₂ equivalent');
  });

  it('announces exactly the digits that are shown, with no truncation mismatch', () => {
    const { visible, spoken } = render('1999999', 'fr-FR');
    const shown = visible.textContent!.split(' ')[0];
    expect(shown).toBe('1,999');
    expect(spoken.textContent!.split(' ')[0]).toBe(shown);
  });
});
