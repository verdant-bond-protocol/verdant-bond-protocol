import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsArray,
  IsEnum,
  ArrayNotEmpty,
} from 'class-validator';
import { CreditTypeEnum } from '../interfaces/bond.interface';
import { IsValidCouponSchedule } from './coupon-schedule.validator';

export class CreateBondDto {
  @IsString()
  @IsNotEmpty()
  projectId: string;

  @IsNumber()
  @IsPositive()
  faceValue: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsNumber({}, { each: true })
  @IsValidCouponSchedule()
  couponSchedule: number[];

  @IsEnum(CreditTypeEnum)
  creditType: CreditTypeEnum;

  @IsNumber()
  @IsPositive()
  maturityDate: number;

  @IsNumber()
  @IsPositive()
  totalSupply: number;
}
