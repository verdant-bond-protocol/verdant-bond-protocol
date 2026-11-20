import { CreditUnitDefinition, PluralForms } from './credit-units';

/**
 * Locale-aware credit quantity formatting (#210).
 *
 * Input is an on-chain minor-unit amount (integer string, 10^decimals per
 * credit). Nothing passes through a float: the whole part is formatted by
 * `Intl.NumberFormat` as a BigInt (exact in every engine) and the kept fraction
 * digits are appended through the locale's own decimal separator and digit
 * shapes. The plural form is selected with `Intl.PluralRules` using the SAME
 * fraction digits that are displayed — CLDR categorises "1" and "1.0"
 * differently in English — and the rules of the language the noun is written
 * in, so a noun and its number always agree.
 *
 * Time O(d) in the number of digits; per-locale Intl objects are cached.
 */

export interface FormattedCreditQuantity {
  /** Localised number exactly as shown, e.g. "1.234,5" in de-DE. */
  number: string;
  /** Visible text, e.g. "1,234.5 carbon credits (tCO₂e)". */
  text: string;
  /** Screen-reader text: the same digits, with unit symbols spelled out. */
  spoken: string;
}

interface LocaleSymbols {
  integer: Intl.NumberFormat;
  decimal: string;
  digits: readonly string[];
}

const symbolsCache = new Map<string, LocaleSymbols>();
const pluralCache = new Map<string, Intl.PluralRules>();

function symbols(locale: string): LocaleSymbols {
  let cached = symbolsCache.get(locale);
  if (!cached) {
    const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    cached = {
      integer,
      decimal: new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
        .formatToParts(1.5)
        .find((part) => part.type === 'decimal')?.value ?? '.',
      digits: Array.from({ length: 10 }, (_, digit) => integer.format(digit)),
    };
    symbolsCache.set(locale, cached);
  }
  return cached;
}

function pluralRules(language: string, fractionDigits: number): Intl.PluralRules {
  const key = `${language}|${fractionDigits}`;
  let rules = pluralCache.get(key);
  if (!rules) {
    rules = new Intl.PluralRules(language, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    pluralCache.set(key, rules);
  }
  return rules;
}

/** Picks names for the locale, then its language, then English. */
function namesFor(unit: CreditUnitDefinition, locale: string): { language: string; forms: PluralForms } {
  const language = locale.split('-')[0];
  for (const candidate of [locale, language, 'en']) {
    const forms = unit.names[candidate];
    if (forms) return { language: candidate, forms };
  }
  throw new Error('Credit unit definitions must include English ("en") names.');
}

/**
 * CLDR plural rules only test the integer part through small ranges and
 * modulo 10, 100, 1000 or 1000000. Keeping `whole mod 10^6` above 10^6 preserves
 * every one of those operands while staying exact as a JS number, so the
 * category is right even for amounts past Number.MAX_SAFE_INTEGER.
 */
function pluralOperand(whole: bigint): bigint {
  const MILLION = 1_000_000n;
  return whole >= MILLION ? MILLION + (whole % MILLION) : whole;
}

export function formatCreditQuantity(
  minorUnits: string | number | bigint,
  unit: CreditUnitDefinition,
  locale: string,
): FormattedCreditQuantity {
  let amount: bigint;
  try {
    amount = BigInt(minorUnits);
  } catch {
    amount = 0n;
  }
  if (amount < 0n) amount = 0n;

  const scale = 10n ** BigInt(unit.decimals);
  const whole = amount / scale;
  // Truncate to the displayed precision: a claimable quantity is never overstated.
  const kept = (amount % scale)
    .toString()
    .padStart(unit.decimals, '0')
    .slice(0, unit.maxFractionDigits);
  let fraction = kept.replace(/0+$/, '');
  if (fraction.length < unit.minFractionDigits) fraction = fraction.padEnd(unit.minFractionDigits, '0');

  const { integer, decimal, digits } = symbols(locale);
  const number =
    integer.format(whole) +
    (fraction ? decimal + fraction.replace(/\d/g, (d) => digits[Number(d)]) : '');

  const { language, forms } = namesFor(unit, locale);
  const category = pluralRules(language, fraction.length).select(Number(`${pluralOperand(whole)}.${fraction || '0'}`));
  const name = forms[category] ?? forms.other;

  return {
    number,
    text: unit.unit ? `${number} ${name} (${unit.unit.symbol})` : `${number} ${name}`,
    spoken: unit.unit ? `${number} ${name}, in ${unit.unit.spoken}` : `${number} ${name}`,
  };
}
