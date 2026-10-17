import { IsBoolean, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class ReleaseGateBypassDto {
  @IsBoolean()
  enable: boolean;

  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'Reason must be at least 10 characters detailing justification' })
  reason: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;
}
