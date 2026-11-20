import { Injectable } from '@nestjs/common';
import { OracleProviderAdapter, MeasurementData } from './provider.interface';
import { ingestSatelliteMeasurement } from '../../../../oracle/satellite-processor';

@Injectable()
export class SatelliteProvider implements OracleProviderAdapter {
  readonly name = 'SatelliteProcessor';
  readonly methodology = 'REMOTE-SENSING';

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

    const baseUrl = process.env.SATELLITE_API_URL;
    const bearerToken = process.env.SATELLITE_BEARER_TOKEN;

    const bboxStr = process.env.SATELLITE_BBOX || '-76.5,-6.2,-76.2,-5.9';
    const bbox = bboxStr.split(',').map(Number) as [number, number, number, number];
    const areaHa = Number(process.env.SATELLITE_AREA_HA) || 1250;
    const baselineNdvi = Number(process.env.SATELLITE_BASELINE_NDVI) || 0.28;

    const report = await ingestSatelliteMeasurement(
      {
        project_id: projectId,
        bbox,
        area_ha: areaHa,
        baseline_ndvi: baselineNdvi,
      },
      { periodStart: pStartStr, periodEnd: pEndStr },
      { ...(baseUrl ? { baseUrl } : {}), ...(bearerToken ? { bearerToken } : {}) },
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

