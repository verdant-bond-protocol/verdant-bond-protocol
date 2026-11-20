import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveOracleIncidentDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resolutionNote?: string;
}
