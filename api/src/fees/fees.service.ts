import { Injectable } from '@nestjs/common';
import { calculateFees, FeeBreakdown, FeeScheduleLine, InvalidFeeInputError } from './fee-calculation';
import { SupportedFeeAsset } from './dto/fee-preview.dto';

export { InvalidFeeInputError };

/** Minor-unit decimal precision per supported asset (matches `config/config.service.ts`'s network defaults). */
const ASSET_DECIMALS: Record<SupportedFeeAsset, number> = {
  USDC: 7,
  XLM: 7,
};

/**
 * Named fee schedules, centralized here so every caller (subscription,
 * redemption, marketplace settlement) prices a transaction the same way
 * instead of each computing its own ad hoc percentage (issue #301).
 *
 * Amounts are minor units of the *quote* asset. `platformFee` covers protocol
 * operating cost; `custodyFee` is a small flat-leaning fee (a low rate with a
 * floor) covering off-chain custody/reporting cost, waived below the floor
 * only when the whole schedule prices to zero (see `calculateFees`'s
 * zero-schedule case).
 */
const FEE_SCHEDULES: Record<'subscription' | 'redemption' | 'marketplace', FeeScheduleLine[]> = {
  subscription: [
    { code: 'platformFee', label: 'Platform fee', basisPoints: 50 }, // 0.50%
    { code: 'custodyFee', label: 'Custody & reporting fee', basisPoints: 10, minFeeMinorUnits: 10_000n }, // 0.10%, min 0.001 unit
  ],
  redemption: [
    { code: 'platformFee', label: 'Platform fee', basisPoints: 25 }, // 0.25%
  ],
  marketplace: [
    { code: 'platformFee', label: 'Platform fee', basisPoints: 75 }, // 0.75%
    { code: 'marketplaceFee', label: 'Marketplace matching fee', basisPoints: 20, maxFeeMinorUnits: 5_000_000n },
  ],
};

@Injectable()
export class FeesService {
  /** The schedule a given name resolves to, exposed so tests and other services don't hardcode the table again. */
  getSchedule(scheduleName: keyof typeof FEE_SCHEDULES = 'subscription'): FeeScheduleLine[] {
    return FEE_SCHEDULES[scheduleName];
  }

  getAssetDecimals(asset: SupportedFeeAsset): number {
    return ASSET_DECIMALS[asset];
  }

  /**
   * Preview the fee breakdown for an amount before final submission, so a
   * caller can show line items to a user (or reconcile them against a stored
   * settlement record) without having actually moved anything yet.
   */
  preview(
    amountMinorUnits: string,
    asset: SupportedFeeAsset,
    scheduleName: keyof typeof FEE_SCHEDULES = 'subscription',
  ): FeeBreakdown {
    return calculateFees(amountMinorUnits, this.getSchedule(scheduleName), this.getAssetDecimals(asset));
  }
}
