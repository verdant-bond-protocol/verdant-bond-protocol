import { IsNumber, IsOptional, IsString, Min, Max } from 'class-validator';

export class UpdatePriceImpactConfigDto {
  @IsOptional()
  @IsString()
  illiquidThresholdAmount?: string;

  @IsOptional()
  @IsString()
  moderateThresholdAmount?: string;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(5000)
  maxLiquidImpactBps?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(5000)
  maxModerateImpactBps?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(5000)
  maxIlliquidImpactBps?: number;

  @IsOptional()
  @IsNumber()
  @Min(100)
  @Max(10000)
  maxIlliquidDepthConsumptionBps?: number;
}
