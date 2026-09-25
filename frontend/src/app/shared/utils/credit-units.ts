import { InjectionToken } from '@angular/core';
import { Bond } from '../interfaces/bond.interface';

export type CreditType = Bond['creditType'];

/**
 * Unit definitions for credit-denominated quantities (#210).
 *
 * Display rules live here, per credit type, instead of inside formatting code.
 * Override the whole table (or a single credit type) by providing
 * `CREDIT_UNITS` — for example to add translated names for another language.
 */

/** Noun forms keyed by CLDR plural category; `other` is the required fallback. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

export interface CreditUnitDefinition {
  /** On-chain minor-unit decimals (`CreditType::decimals`, contracts/shared/src/types.rs). */
  decimals: number;
  /** Fraction digits shown. Extra digits are truncated, never rounded up. */
  minFractionDigits: number;
  maxFractionDigits: number;
  /** Credit names by language (BCP 47 language or full locale tag). */
  names: Record<string, PluralForms>;
  /** Physical unit one credit represents, where the standard defines one. */
  unit?: { symbol: string; spoken: string };
}

/**
 * One carbon credit (e.g. a Verra VCU) is one tonne of CO₂e, so carbon and
 * blue-carbon quantities keep 3 decimals (kilogram resolution). Biodiversity
 * credits have no standard physical unit, so none is claimed for them or for
 * mixed baskets.
 */
const TONNE_CO2E = { symbol: 'tCO₂e', spoken: 'tonnes of CO₂ equivalent' };

export const DEFAULT_CREDIT_UNITS: Record<CreditType, CreditUnitDefinition> = {
  Carbon: {
    decimals: 6,
    minFractionDigits: 0,
    maxFractionDigits: 3,
    names: { en: { one: 'carbon credit', other: 'carbon credits' } },
    unit: TONNE_CO2E,
  },
  BlueCarbon: {
    decimals: 6,
    minFractionDigits: 0,
    maxFractionDigits: 3,
    names: { en: { one: 'blue carbon credit', other: 'blue carbon credits' } },
    unit: TONNE_CO2E,
  },
  Biodiversity: {
    decimals: 6,
    minFractionDigits: 0,
    maxFractionDigits: 2,
    names: { en: { one: 'biodiversity credit', other: 'biodiversity credits' } },
  },
  Basket: {
    decimals: 6,
    minFractionDigits: 0,
    maxFractionDigits: 2,
    names: { en: { one: 'basket credit', other: 'basket credits' } },
  },
};

export const CREDIT_UNITS = new InjectionToken<Record<CreditType, CreditUnitDefinition>>('CREDIT_UNITS', {
  providedIn: 'root',
  factory: () => DEFAULT_CREDIT_UNITS,
});
