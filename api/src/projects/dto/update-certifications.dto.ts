import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CertificationKind } from '../interfaces/project.interface';

export class UpdateProjectCertificationsDto {
  @IsArray()
  @IsNotEmpty()
  @IsString({ each: true })
  cids: string[];

  @IsOptional()
  @IsIn(['performance-report', 'third-party-certification', 'document'])
  kind?: CertificationKind;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
