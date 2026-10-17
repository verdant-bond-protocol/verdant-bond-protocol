import { IsObject, IsString, Length } from 'class-validator';

/** Body of `PUT /admin/config/policy` (#408). Per-setting rules live in PolicyConfigChangeService. */
export class PolicyConfigChangeDto {
  /** Client-generated id; resend the same id to retry safely. */
  @IsString()
  @Length(1, 128)
  changeId: string;

  @IsString()
  @Length(1, 500)
  reason: string;

  @IsObject()
  updates: Record<string, unknown>;
}

/** Body of `POST /admin/config/policy/rollback` (#408). */
export class PolicyConfigRollbackDto {
  @IsString()
  @Length(1, 128)
  changeId: string;

  @IsString()
  @Length(1, 500)
  reason: string;

  /** The applied change to undo. */
  @IsString()
  @Length(1, 128)
  targetChangeId: string;
}
