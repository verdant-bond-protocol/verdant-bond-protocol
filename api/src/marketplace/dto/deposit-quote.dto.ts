import { IsNumber, IsPositive, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsQuoteAssetSymbol } from '../../common/decorators/is-quote-asset.decorator';
import { QuoteAssetSymbol } from '../quote-assets';

export class DepositQuoteDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsQuoteAssetSymbol()
  asset: QuoteAssetSymbol;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
