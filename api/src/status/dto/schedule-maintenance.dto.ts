import { IsDateString, IsString, MinLength } from 'class-validator';

export class ScheduleMaintenanceDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;
}
