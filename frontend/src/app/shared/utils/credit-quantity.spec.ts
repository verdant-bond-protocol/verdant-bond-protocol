import { formatCreditQuantity } from './credit-quantity';
import { CreditUnitDefinition, DEFAULT_CREDIT_UNITS } from './credit-units';

const NNBSP = ' ';
const carbon = DEFAULT_CREDIT_UNITS.Carbon;
const biodiversity = DEFAULT_CREDIT_UNITS.Biodiversity;
const minor = (credits: string) => {
  const [whole, fraction = ''] = credits.split('.');
  return `${whole}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
};

describe('formatCreditQuantity (#210)', () => {
  describe('grouping across locales', () => {
    const cases: Array<[string, string]> = [
      ['en-US', '1,234,567.5'],
      ['de-DE', '1.234.567,5'],
      ['fr-FR', `1${NNBSP}234${NNBSP}567,5`],
      ['hi-IN', '12,34,567.5'],
    ];
    for (const [locale, expected] of cases) {
      it(`groups and separates decimals the ${locale} way`, () => {
        expect(formatCreditQuantity(minor('1234567.5'), carbon, locale).number).toBe(expected);
      });
    }

    it('uses the locale digit shapes for every digit, including fractions', () => {
      expect(formatCreditQuantity(minor('12.25'), biodiversity, 'ar-EG').number).toBe('١٢٫٢٥');
    });
  });

  describe('English pluralization', () => {
    it('agrees with the displayed number, not the raw value', () => {
      expect(formatCreditQuantity(minor('1'), carbon, 'en-US').text).toBe('1 carbon credit (tCO₂e)');
      expect(formatCreditQuantity(minor('1.5'), carbon, 'en-US').text).toBe('1.5 carbon credits (tCO₂e)');
      expect(formatCreditQuantity('0', biodiversity, 'en-US').text).toBe('0 biodiversity credits');
      // 1.000999 truncates to "1" at 3 decimals, so the noun is singular.
      expect(formatCreditQuantity('1000999', carbon, 'en-US').text).toBe('1 carbon credit (tCO₂e)');
    });

    it('uses "other" for "1.0" when a unit shows fixed decimals (CLDR v≠0)', () => {
      const fixed: CreditUnitDefinition = { ...biodiversity, minFractionDigits: 1 };
      expect(formatCreditQuantity(minor('1'), fixed, 'en-US').text).toBe('1.0 biodiversity credits');
    });

    it('applies English rules to English names even in a French locale', () => {
      // French CLDR puts 0 and 1.5 in "one"; the English noun must still be plural.
      expect(formatCreditQuantity(minor('1.5'), biodiversity, 'fr-FR').text).toBe('1,5 biodiversity credits');
      expect(formatCreditQuantity('0', biodiversity, 'fr-FR').text).toBe('0 biodiversity credits');
    });
  });

  describe('languages with more plural categories', () => {
    const polish: CreditUnitDefinition = {
      ...biodiversity,
      names: { ...biodiversity.names, pl: { one: 'kredyt', few: 'kredyty', many: 'kredytów', other: 'kredytu' } },
    };
    const arabic: CreditUnitDefinition = {
      ...biodiversity,
      names: { ...biodiversity.names, ar: { zero: 'Z', one: 'O', two: 'T', few: 'F', many: 'M', other: 'X' } },
    };

    it('selects Polish one / few / many / other', () => {
      const name = (credits: string) => formatCreditQuantity(minor(credits), polish, 'pl-PL').text.split(' ').pop();
      expect([name('1'), name('2'), name('5'), name('22'), name('1.5')]).toEqual(['kredyt', 'kredyty', 'kredytów', 'kredyty', 'kredytu']);
    });

    it('selects all six Arabic categories', () => {
      const name = (credits: string) => formatCreditQuantity(minor(credits), arabic, 'ar-EG').text.split(' ').pop();
      expect(['0', '1', '2', '3', '11', '100'].map(name)).toEqual(['Z', 'O', 'T', 'F', 'M', 'X']);
    });

    it('keeps the category exact for amounts past Number.MAX_SAFE_INTEGER', () => {
      // 10^20 + 2 credits: last two integer digits "02" → Polish "few".
      const amount = (10n ** 20n + 2n) * 1_000_000n;
      expect(formatCreditQuantity(amount, polish, 'pl-PL').text).toMatch(/kredyty$/);
    });
  });

  describe('precision', () => {
    it('is configurable per credit type and truncates instead of rounding up', () => {
      expect(formatCreditQuantity('1999999', carbon, 'en-US').number).toBe('1.999');
      expect(formatCreditQuantity('1999999', biodiversity, 'en-US').number).toBe('1.99');
      expect(formatCreditQuantity('1999999', { ...biodiversity, maxFractionDigits: 6 }, 'en-US').number).toBe('1.999999');
    });

    it('never loses digits for very large quantities', () => {
      const amount = 123456789012345678901234n * 1_000_000n + 500_000n;
      expect(formatCreditQuantity(amount, carbon, 'en-US').number).toBe('123,456,789,012,345,678,901,234.5');
    });

    it('treats invalid or negative input as zero', () => {
      expect(formatCreditQuantity('abc', carbon, 'en-US').number).toBe('0');
      expect(formatCreditQuantity('-5', carbon, 'en-US').number).toBe('0');
    });
  });

  it('gives screen readers the same digits with the unit spelled out', () => {
    const result = formatCreditQuantity(minor('1234.5'), carbon, 'de-DE');
    expect(result.text).toBe('1.234,5 carbon credits (tCO₂e)');
    expect(result.spoken).toBe('1.234,5 carbon credits, in tonnes of CO₂ equivalent');
    expect(result.spoken.startsWith(result.number)).toBeTrue();
  });
});
