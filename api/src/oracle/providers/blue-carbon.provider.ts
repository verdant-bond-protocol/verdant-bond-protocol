import { Injectable } from '@nestjs/common';
import { OracleProviderAdapter, MeasurementData } from './provider.interface';
import { aggregateBlueCarbonProject } from '../../../../oracle/blue-carbon-adapter';

@Injectable()
export class BlueCarbonProvider implements OracleProviderAdapter {
  readonly name = 'BlueCarbonObservatory';
  readonly methodology = 'BLUE-CARBON';

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

    const baseUrl = process.env.BLUE_CARBON_API_URL;
    const habitat = (process.env.BLUE_CARBON_HABITAT as 'mangrove' | 'seagrass' | 'saltmarsh') || 'mangrove';
    const areaHa = Number(process.env.BLUE_CARBON_AREA_HA) || 500;
    const baselineCarbon = Number(process.env.BLUE_CARBON_BASELINE) || 480;
    const rootShootRatio = Number(process.env.BLUE_CARBON_ROOT_SHOOT_RATIO) || 0.8;

    const report = await aggregateBlueCarbonProject(
      {
        project_id: projectId,
        habitat,
        area_ha: areaHa,
        baseline_carbon_t_per_ha: baselineCarbon,
        root_shoot_ratio: rootShootRatio,
      },
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

