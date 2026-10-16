import { Global, Module } from '@nestjs/common';
import { EventLedgerService } from './event-ledger.service';
import { LedgerController } from './ledger.controller';

/**
 * Global so any service performing a privileged or financial action can
 * inject `EventLedgerService` (as `@Optional()`, keeping existing module
 * wiring and unit tests unchanged) without importing this module.
 */
@Global()
@Module({
  controllers: [LedgerController],
  providers: [EventLedgerService],
  exports: [EventLedgerService],
})
export class LedgerModule {}
