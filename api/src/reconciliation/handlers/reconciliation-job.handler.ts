import { Injectable, Logger } from '@nestjs/common';
import { JobHandler } from '../../workers/services/worker.service';
import { ReconciliationService } from '../services/reconciliation.service';

@Injectable()
export class ReconciliationJobHandler implements JobHandler {
  private readonly logger = new Logger(ReconciliationJobHandler.name);

  constructor(private readonly reconciliation: ReconciliationService) {}

  async handle(payload: any): Promise<Record<string, any>> {
    const { dryRun = true } = payload;

    this.logger.log(`Processing reconciliation job (dryRun=${dryRun})`);

    const report = await this.reconciliation.reconcile(dryRun, {
      timestamp: new Date(),
    });

    return {
      reportId: `reconciliation-${Date.now()}`,
      dryRun: report.dryRun,
      timestamp: report.timestamp.toISOString(),
      driftsFound: report.driftsFound.length,
      summary: report.summary,
      drifts: report.driftsFound.slice(0, 100), // Limit to first 100 for response
    };
  }
}
