import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { ImportRow } from '../../common/services/bulk-import.service';

export class ImportRowDto implements ImportRow {
  @IsString()
  @MinLength(1)
  externalId: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsString()
  @MinLength(1)
  targetAddress: string;
}

export class StartImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows: ImportRowDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  chunkSize?: number;
}
