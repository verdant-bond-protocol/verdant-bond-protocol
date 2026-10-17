import { IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';

export class DistributeCouponBatchDto {
  @IsNumber()
  @IsPositive()
  periodIndex: number;

  @IsNumber()
  @IsPositive()
  reportId: number;

  @IsNumber()
  @Min(0)
  offset: number;

  @IsNumber()
  @IsPositive()
  @Max(100)
  limit: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  batchSize?: number;
}
