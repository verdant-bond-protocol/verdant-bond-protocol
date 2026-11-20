import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class HistoricalOracleCorrectionDto {
  @IsNumber()
  @IsPositive()
  reportId: number;

  @IsString()
  @IsNotEmpty()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  correctedCarbonSequestered: string;

  @IsOptional()
  @IsNumber()
  correctedBiodiversityScore?: number;

  @IsString()
  @IsNotEmpty()
  correctionEvidenceHash: string;

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  compensateBonds?: boolean;
}
