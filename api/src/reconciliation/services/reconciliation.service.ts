import { Injectable, Logger } from '@nestjs/common';
import {
  ReconciliationDrift,
  ReconciliationReport,
  ReconciliationInvariant,
} from '../interfaces/reconciliation.interface';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private invariants: ReconciliationInvariant[] = [];

  registerInvariant(invariant: ReconciliationInvariant): void {
    this.invariants.push(invariant);
    this.logger.log(`Registered reconciliation invariant: ${invariant.name}`);
  }

  async runDryRun(context?: any): Promise<ReconciliationReport> {
    return this.reconcile(true, context);
  }

  async reconcile(dryRun = true, context?: any): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const report: ReconciliationReport = {
      timestamp: new Date(),
      dryRun,
      totalEntitiesChecked: 0,
      driftsFound: [],
      summary: {
        missingCount: 0,
        duplicateCount: 0,
        staleCount: 0,
        inconsistentCount: 0,
      },
    };

    this.logger.log(
      `Starting ${dryRun ? 'dry-run' : 'live'} reconciliation with ${this.invariants.length} invariants`,
    );

    for (const invariant of this.invariants) {
      try {
        const drifts = await invariant.check(context || {});
        report.driftsFound.push(...drifts);

        for (const drift of drifts) {
          if (drift.type === 'missing') report.summary.missingCount++;
          else if (drift.type === 'duplicate') report.summary.duplicateCount++;
          else if (drift.type === 'stale') report.summary.staleCount++;
          else if (drift.type === 'inconsistent') report.summary.inconsistentCount++;
        }
      } catch (error) {
        this.logger.error(`Error in invariant ${invariant.name}: ${error}`);
        report.driftsFound.push({
          type: 'inconsistent',
          entityType: invariant.name,
          entityId: 'error',
          description: `Failed to check invariant: ${error instanceof Error ? error.message : String(error)}`,
        });
        report.summary.inconsistentCount++;
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Reconciliation ${dryRun ? 'dry-run' : 'complete'} in ${duration}ms. Found ${report.driftsFound.length} drifts.`,
    );

    return report;
  }

  getInvariantCount(): number {
    return this.invariants.length;
  }
}
