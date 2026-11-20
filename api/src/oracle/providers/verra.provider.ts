import { Injectable } from '@nestjs/common';
import { OracleProviderAdapter, MeasurementData } from './provider.interface';
import { pollVerraProject } from '../../../../oracle/verra-adapter';

@Injectable()
export class VerraProvider implements OracleProviderAdapter {
  readonly name = 'Verra';
  readonly methodology = 'VERRA-VCS';

  async fetchMeasurement(
    projectId: string,
    periodStart?: Date | string,
    periodEnd?: Date | string,
  ): Promise<MeasurementData> {
    const pStartStr = periodStart
      ? periodStart instanceof Date
        ? periodStart.toISOString().split('T')[0]
        : periodStart
      : process.env.ORACLE_PERIOD_START || '2025-01-01';

    const pEndStr = periodEnd
      ? periodEnd instanceof Date
        ? periodEnd.toISOString().split('T')[0]
        : periodEnd
      : process.env.ORACLE_PERIOD_END || '2025-03-31';

    const baseUrl = process.env.VERRA_API_URL || process.env.VERRA_REGISTRY_URL;

    const report = await pollVerraProject(
      projectId,
      { periodStart: pStartStr, periodEnd: pEndStr },
      baseUrl ? { baseUrl } : {},
    );

    return {
      projectId: report.project_id,
      periodStart: new Date(report.period_start),
      periodEnd: new Date(report.period_end),
      carbonSequesteredKg: report.carbon_sequestered,
      confidence: report.confidence,
      evidenceHashes: [report.ipfs_evidence_hash],
    };
  }
}

