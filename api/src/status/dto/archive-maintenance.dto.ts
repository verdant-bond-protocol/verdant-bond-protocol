import { IsString, MinLength } from 'class-validator';

/**
 * Archiving a maintenance window requires a written reason. The window is
 * withdrawn from the public status feed, and an unexplained disappearance is
 * worse than the maintenance it announced — so the reason is mandatory rather
 * than an optional note.
 */
export class ArchiveMaintenanceDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
