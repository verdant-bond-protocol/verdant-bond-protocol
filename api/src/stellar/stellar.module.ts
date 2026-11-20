import { Global, Module } from '@nestjs/common';
import { StellarService } from './stellar.service';
import { ContractService } from './contract.service';
import { StellarController } from './stellar.controller';

@Global()
@Module({
  controllers: [StellarController],
  providers: [StellarService, ContractService],
  exports: [StellarService, ContractService],
})
export class StellarModule {}
