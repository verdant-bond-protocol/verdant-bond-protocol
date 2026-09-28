import { IsInt, Min } from 'class-validator';

export class RenewAuthorizationDto {
  @IsInt()
  @Min(1)
  ttlMs: number;
}
