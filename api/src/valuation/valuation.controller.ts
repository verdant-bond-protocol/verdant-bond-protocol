import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { ValuationReport } from './valuation.interface';
import { ValuationService } from './valuation.service';

const CREDIT_TYPES = new Set<string>(Object.values(CreditTypeEnum));

@Controller('valuations')
export class ValuationController {
  constructor(private readonly valuationService: ValuationService) {}

  /**
   * Fiat-equivalent credit valuations with staleness metadata (#204). Public:
   * it exposes market prices only. `creditType` may be repeated or
   * comma-separated to narrow the report.
   */
  @Get()
  async getValuations(@Query('creditType') creditType?: string | string[]): Promise<ValuationReport> {
    if (creditType === undefined) return this.valuationService.getReport();

    const requested = [creditType].flat().flatMap((value) => value.split(',')).map((value) => value.trim());
    const unknown = requested.filter((value) => !CREDIT_TYPES.has(value));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown credit type(s): ${unknown.join(', ')}`);
    }
    return this.valuationService.getReport([...new Set(requested)] as CreditTypeEnum[]);
  }
}
