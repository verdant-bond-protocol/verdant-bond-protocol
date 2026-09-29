import { Injectable } from '@nestjs/common';
import { OracleProviderAdapter, MeasurementData } from './provider.interface';
import { aggregateIotProject } from '../../../../oracle/iot-aggregator';

@Injectable()
export class IotProvider implements OracleProviderAdapter {
  readonly name = 'IotSensorNetwork';
  readonly methodology = 'IOT-SENSORS';

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

    const baseUrl = process.env.IOT_API_URL;
    const deviceIdsStr = process.env.IOT_DEVICE_IDS || 'NBS-SOIL-001,NBS-SOIL-002';
    const deviceIds = deviceIdsStr.split(',').map((s) => s.trim()).filter(Boolean);
    const areaHa = Number(process.env.IOT_AREA_HA) || 1250;

    const report = await aggregateIotProject(
      {
        project_id: projectId,
        device_ids: deviceIds,
        area_ha: areaHa,
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
