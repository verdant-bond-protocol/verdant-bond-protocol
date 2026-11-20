import {
  IsString, IsNotEmpty, IsNumber, IsPositive, IsOptional,
  IsBoolean, IsObject, ValidateNested, IsIn, Matches, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VALID_METHODOLOGY_CODES } from '../constants/methodology';

export class LocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;
}

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_METHODOLOGY_CODES)
  methodology: string;

  // Assumed ISO 3166-1 alpha-2 (two uppercase letters). No format is
  // documented in docs/credit-methodology.md, but this matches the
  // existing "BR" placeholder used across the app.
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{2}$/, { message: 'country must be an ISO 3166-1 alpha-2 code' })
  country: string;

  @IsObject()
  @ValidateNested()
  @Type(() => LocationDto)
  location: LocationDto;

  @IsNumber()
  @IsPositive()
  totalAreaHa: number;

  @IsNumber()
  @IsPositive()
  carbonSequestrationEstimate: number;

  @IsOptional()
  @IsBoolean()
  blueCarbon?: boolean;

  @IsOptional()
  @IsBoolean()
  biodiversityCorridor?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  boundary?: Record<string, any>;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
