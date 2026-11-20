import { BadRequestException } from '@nestjs/common';
import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { ValuationController } from './valuation.controller';
import { ValuationService } from './valuation.service';

describe('ValuationController (#204)', () => {
  const getReport = jest.fn().mockResolvedValue({});
  const controller = new ValuationController({ getReport } as unknown as ValuationService);

  beforeEach(() => getReport.mockClear());

  it('reports every credit type by default', async () => {
    await controller.getValuations();
    expect(getReport).toHaveBeenCalledWith();
  });

  it('accepts repeated and comma-separated credit types, de-duplicated', async () => {
    await controller.getValuations(['Carbon,BlueCarbon', 'Carbon']);
    expect(getReport).toHaveBeenCalledWith([CreditTypeEnum.Carbon, CreditTypeEnum.BlueCarbon]);
  });

  it('rejects an unknown credit type', async () => {
    await expect(controller.getValuations('Gold')).rejects.toBeInstanceOf(BadRequestException);
    expect(getReport).not.toHaveBeenCalled();
  });
});
