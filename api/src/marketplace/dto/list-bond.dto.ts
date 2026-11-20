import { IsNumber, IsPositive, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsQuoteAssetSymbol } from '../../common/decorators/is-quote-asset.decorator';
import { QuoteAssetSymbol } from '../quote-assets';

export class ListBondDto {
  @IsNumber()
  @IsPositive()
  bondId: number;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsNumber()
  @IsPositive()
  pricePerToken: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsQuoteAssetSymbol()
  quoteAsset: QuoteAssetSymbol;

  @IsNumber()
  @IsOptional()
  expiresAfterSeconds?: number = 604800;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
