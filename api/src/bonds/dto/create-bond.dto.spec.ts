import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBondDto } from './create-bond.dto';
import { CreditTypeEnum } from '../interfaces/bond.interface';

describe('CreateBondDto', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maturityDate = nowSeconds + 365 * 24 * 60 * 60;

  const validPayload = {
    projectId: 'p1',
    faceValue: 100000,
    couponSchedule: [nowSeconds + 1000, nowSeconds + 2000, nowSeconds + 3000],
    creditType: CreditTypeEnum.Carbon,
    maturityDate,
    totalSupply: 1000,
  };

  it('accepts a valid ascending schedule', async () => {
    const dto = plainToInstance(CreateBondDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty schedule', async () => {
    const dto = plainToInstance(CreateBondDto, { ...validPayload, couponSchedule: [] });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'couponSchedule')).toBe(true);
  });

  it('rejects a coupon date equal to maturityDate', async () => {
    const dto = plainToInstance(CreateBondDto, {
      ...validPayload,
      couponSchedule: [nowSeconds + 1000, maturityDate],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'couponSchedule')).toBe(true);
  });

  it('rejects a coupon date equal to now', async () => {
    const dto = plainToInstance(CreateBondDto, {
      ...validPayload,
      couponSchedule: [nowSeconds],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'couponSchedule')).toBe(true);
  });

  it('rejects an unordered schedule', async () => {
    const dto = plainToInstance(CreateBondDto, {
      ...validPayload,
      couponSchedule: [nowSeconds + 3000, nowSeconds + 1000],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'couponSchedule')).toBe(true);
  });

  it('rejects a duplicate coupon date', async () => {
    const dto = plainToInstance(CreateBondDto, {
      ...validPayload,
      couponSchedule: [nowSeconds + 1000, nowSeconds + 1000],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'couponSchedule')).toBe(true);
  });
});
