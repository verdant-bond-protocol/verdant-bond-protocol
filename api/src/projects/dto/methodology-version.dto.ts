import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMethodologyVersionDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsString()
  @IsNotEmpty()
  effectiveDate!: string;

  @IsString()
  @IsNotEmpty()
  documentContent!: string;
}

export class DeprecateMethodologyDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class PinBondMethodologyDto {
  @IsString()
  @IsNotEmpty()
  methodologyId!: string;

  @IsString()
  @IsNotEmpty()
  version!: string;
}

export class RecordReportMethodologyDto {
  @IsInt()
  @Min(1)
  bondId!: number;

  @IsString()
  @IsNotEmpty()
  methodologyId!: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsOptional()
  @IsString()
  overrideReason?: string;

  @IsOptional()
  @IsString()
  overrideApprovedBy?: string;
}

class LegacyReportRefDto {
  @IsInt()
  @Min(1)
  reportId!: number;

  @IsInt()
  @Min(1)
  bondId!: number;
}

export class MigrateLegacyMethodologyDto {
  @IsArray()
  @IsInt({ each: true })
  bondIds!: number[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegacyReportRefDto)
  reports!: LegacyReportRefDto[];
}
