import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class PaginatedResponse<T> {
  data: T[];
  meta: {
    page?: number;
    limit: number;
    total: number;
    totalPages?: number;
    nextCursor?: string | number;
  };
}
