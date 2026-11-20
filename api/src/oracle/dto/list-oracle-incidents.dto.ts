import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { OracleIncidentStatus } from '../interfaces/oracle-incident.interface';

export class ListOracleIncidentsDto extends PaginationDto {
  @IsOptional()
  @IsEnum(OracleIncidentStatus)
  status?: OracleIncidentStatus;
}
