import { IsNumber, IsPositive } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsQuoteAssetSymbol } from '../../common/decorators/is-quote-asset.decorator';
import { QuoteAssetSymbol } from '../quote-assets';

export class QuoteTxDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsQuoteAssetSymbol()
  quoteAsset: QuoteAssetSymbol;

  @IsNumber()
  @IsPositive()
  amount: number;
}
