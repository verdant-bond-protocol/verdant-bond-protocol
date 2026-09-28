import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** Asset codes with a known, fixed decimal precision this API supports pricing for. */
export const SUPPORTED_FEE_ASSETS = ['USDC', 'XLM'] as const;
export type SupportedFeeAsset = (typeof SUPPORTED_FEE_ASSETS)[number];

export class FeePreviewDto {
  /** Amount in the asset's minor units, as a base-10 integer string (never a float). */
  @IsString()
  @Matches(/^\d+$/, { message: 'amountMinorUnits must be a non-negative integer string' })
  amountMinorUnits: string;

  @IsIn(SUPPORTED_FEE_ASSETS)
  asset: SupportedFeeAsset;

  /** Which named schedule to price under (e.g. subscription vs. redemption). Defaults to 'subscription'. */
  @IsOptional()
  @IsIn(['subscription', 'redemption', 'marketplace'])
  scheduleName?: 'subscription' | 'redemption' | 'marketplace';
}
