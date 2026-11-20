import { Controller, Get, Param } from '@nestjs/common';
import { ContractService, TransactionStatusResult } from './contract.service';

@Controller('stellar')
export class StellarController {
  constructor(private readonly contractService: ContractService) {}

  @Get('transactions/:hash')
  getTransactionStatus(@Param('hash') hash: string): Promise<TransactionStatusResult> {
    return this.contractService.getTransactionStatus(hash);
  }
}
