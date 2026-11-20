import { IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsQuoteAssetSymbol } from '../../common/decorators/is-quote-asset.decorator';
import { QuoteAssetSymbol } from '../quote-assets';

export class QuoteBalanceQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsQuoteAssetSymbol()
  asset?: QuoteAssetSymbol;
}
