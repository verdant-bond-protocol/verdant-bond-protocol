import { IsInt, IsString, Min } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

export class GrantAuthorizationDto {
  @IsString()
  @IsStellarAddress()
  subjectAddress: string;

  @IsString()
  scope: string;

  /** Time to live in milliseconds from now. */
  @IsInt()
  @Min(1)
  ttlMs: number;
}
