import { IsNumber, IsPositive, IsString, IsOptional } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

export class RedeemBondDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsStellarAddress()
  investorAddress: string;

  @IsOptional()
  @IsNumber()
  nonce?: number;
}

export interface RedeemBondResponse {
  bondId: number;
  investorAddress: string;
  amount: string;
  transactionHash: string;
  status?: string;
}
