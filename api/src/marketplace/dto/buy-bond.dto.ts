import { IsNumber, IsPositive, IsOptional, IsInt, Min, Max } from 'class-validator';

export class BuyBondDto {
  @IsNumber()
  @IsPositive()
  orderId: number;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsNumber()
  @IsPositive()
  maxPrice: number;

  @IsNumber()
  @IsOptional()
  nonce?: number;

  /**
   * Buyer's slippage tolerance in basis points over the best resting ask
   * (#638). Optional; when set, the stricter of this and the tranche's
   * tier cap applies. `0` means "only fill at the best ask".
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  maxPriceImpactBps?: number;
}
