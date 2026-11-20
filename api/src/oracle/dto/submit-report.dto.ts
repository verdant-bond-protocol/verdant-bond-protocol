import { IsString, IsNotEmpty, IsNumber, IsPositive, Min, IsOptional, IsObject } from 'class-validator';
import { IsEvidenceReference } from '../../common/decorators/is-evidence-reference.decorator';

export class SubmitReportDto {
  @IsString()
  @IsNotEmpty()
  projectId: string;

  @IsNumber()
  @IsPositive()
  periodStart: number;

  @IsNumber()
  @IsPositive()
  periodEnd: number;

  @IsNumber()
  @Min(0)
  carbonSequestered: number;

  @IsString()
  @IsNotEmpty()
  methodology: string;

  /**
   * Reference to external supporting evidence (issue #93) -- a CIDv0 or a
   * 64-character hex SHA-256 digest. Rejected before IPFS upload or any
   * contract call when malformed; see `docs/oracle-design.md`.
   */
  @IsString()
  @IsOptional()
  @IsEvidenceReference()
  evidenceHash?: string;

  @IsOptional()
  @IsObject()
  manifest?: Record<string, any>;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
