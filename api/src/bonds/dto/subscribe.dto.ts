import { IsNumber, IsPositive, IsString, IsOptional, IsEnum } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';
import { SignedEligibilityAttestation, TrancheType } from '../../compliance/interfaces/compliance.interface';

export class SubscribeDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsNumber()
  nonce?: number;

  @IsString()
  @IsStellarAddress()
  investorAddress: string;

  @IsOptional()
  @IsEnum(TrancheType)
  tranche?: TrancheType;

  @IsOptional()
  @IsString()
  jurisdiction?: string;

  @IsOptional()
  attestation?: SignedEligibilityAttestation;
}
