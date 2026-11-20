import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DexReconciliationService } from './dex.reconciliation.service';

const DEFAULT_CRON = CronExpression.EVERY_10_MINUTES;

/**
 * Drives the marketplace reconciliation job (#recon) on a schedule. Each tick
 * runs `DexReconciliationService.reconcile()`; mismatches are logged (with a
 * correlation id) and persisted by the service for operators. Repair is a
 * manual operator action via POST /marketplace/reconciliation/repair so that
 * cache eviction is deliberate.
 */
@Injectable()
export class DexReconciliationScheduler {
  private readonly logger = new Logger(DexReconciliationScheduler.name);

  constructor(private readonly reconciliation: DexReconciliationService) {}

  @Cron(process.env.DEX_RECON_CRON || DEFAULT_CRON)
  async runReconciliation(): Promise<void> {
    if (!process.env.DEX_ROUTER_ADDRESS) {
      this.logger.debug('Skipping marketplace reconciliation: DEX_ROUTER_ADDRESS unset');
      return;
    }
    this.logger.log('Marketplace reconciliation started');
    try {
      const report = await this.reconciliation.reconcile();
      this.logger.log(
        `Marketplace reconciliation finished: correlationId=${report.correlationId} ` +
          `balances=${report.checkedBalances} orders=${report.checkedOrders} mismatches=${report.mismatches.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Marketplace reconciliation error: ${message}`);
    }
  }
}
