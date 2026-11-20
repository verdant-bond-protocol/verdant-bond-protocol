import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { METHODOLOGY_CODES } from '../constants/methodology';

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Rejects a methodology that isn't one of the canonical codes. Mirrors the
 *  @IsIn(VALID_METHODOLOGY_CODES) check in api/src/projects/dto/create-project.dto.ts. */
export function methodologyValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined || value === '') return null;
    return METHODOLOGY_CODES.includes(value) ? null : { invalidMethodology: true };
  };
}

/** Requires an ISO 3166-1 alpha-2 code (two uppercase letters). Mirrors the
 *  @Matches(/^[A-Z]{2}$/) check on CreateProjectDto.country. */
export function countryCodeValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined || value === '') return null;
    return COUNTRY_CODE_PATTERN.test(value) ? null : { invalidCountryCode: true };
  };
}

/** Mirrors @Min(-90) @Max(90) on LocationDto.lat. */
export function latitudeRangeValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return num >= -90 && num <= 90 ? null : { latitudeOutOfRange: true };
  };
}

/** Mirrors @Min(-180) @Max(180) on LocationDto.lng. */
export function longitudeRangeValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return num >= -180 && num <= 180 ? null : { longitudeOutOfRange: true };
  };
}
