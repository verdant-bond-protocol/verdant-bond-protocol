import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { ConversionPurpose } from '../quote-conversion.interface';

const PURPOSES: readonly ConversionPurpose[] = [
  'bond_subscription',
  'coupon_settlement',
  'secondary_trade',
  'redemption',
];

export class IssueQuoteDto {
  @IsString()
  @IsNotEmpty()
  baseCurrency!: string;

  @IsString()
  @IsNotEmpty()
  quoteCurrency!: string;

  @IsString()
  @Matches(/^\d+$/, { message: 'amount must be a positive integer string in minor units' })
  amount!: string;

  @IsIn(PURPOSES)
  purpose!: ConversionPurpose;

  @IsOptional()
  @IsString()
  account?: string;
}

export class ConsumeQuoteDto {
  @IsIn(PURPOSES)
  purpose!: ConversionPurpose;

  @IsOptional()
  @IsString()
  account?: string;
}
