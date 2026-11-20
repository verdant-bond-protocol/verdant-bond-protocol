import {
  aggregateIotProject,
  aggregateSensorReadings,
  validateIotReading,
  meanSoilCarbonDeltaPpm,
  IotSchemaError,
  IotNoValidReadingsError,
  IotNoSoilCarbonDeltaError,
  IotAdapterError,
  KG_CO2E_PER_HA_PER_PPM,
} from './iot-aggregator';
import { MockHttpClient } from './test-helpers';

const BASE_URL = 'https://api.iot-sensor-network.io/v1';

const READINGS = [
  {
    device_id: 'NBS-SOIL-001',
    timestamp: '2025-02-15T06:00:00Z',
    metrics: {
      soil_moisture: 32.5,
      temperature: 24.1,
      humidity: 68.0,
      soil_carbon_ppm: 4200,
      water_table_cm: 185,
      co2_ppm: 410,
    },
  },
  {
    device_id: 'NBS-SOIL-001',
    timestamp: '2025-03-15T06:00:00Z',
    metrics: {
      soil_moisture: 31.9,
      temperature: 26.4,
      humidity: 71.0,
      soil_carbon_ppm: 4350,
      water_table_cm: 172,
      co2_ppm: 408,
    },
  },
  {
    device_id: 'NBS-SOIL-002',
    timestamp: '2025-03-28T06:00:00Z',
    metrics: {
      soil_moisture: 30.2,
      temperature: 25.8,
      humidity: 63.0,
      soil_carbon_ppm: 4050,
      water_table_cm: 190,
      co2_ppm: 411,
    },
  },
];

const PROJECT = {
  project_id: 'VCS-1234',
  device_ids: ['NBS-SOIL-001', 'NBS-SOIL-002'],
  area_ha: 1250,
};

const PERIOD = { periodStart: '2025-01-01', periodEnd: '2025-03-31' };

describe('validateIotReading', () => {
  it('accepts a well-formed reading', () => {
    expect(validateIotReading(READINGS[0] as any)).toBe(true);
  });

  it('rejects out-of-range metrics', () => {
    const bad = { ...READINGS[0], metrics: { ...READINGS[0].metrics, soil_moisture: 150 } };
    expect(validateIotReading(bad as any)).toBe(false);
  });
});

describe('aggregateSensorReadings', () => {
  it('averages metrics across valid readings', () => {
    const aggregate = aggregateSensorReadings(READINGS as any);
    expect(aggregate.sampleCount).toBe(3);
    expect(aggregate.deviceCount).toBe(2);
    expect(aggregate.avgSoilMoisture).toBeCloseTo((32.5 + 31.9 + 30.2) / 3);
    expect(aggregate.avgSoilCarbonPpm).toBeCloseTo((4200 + 4350 + 4050) / 3);
    expect(aggregate.avgWaterTableCm).toBeCloseTo((185 + 172 + 190) / 3);
  });
});

describe('aggregateIotProject', () => {
  it('produces a validated IOT_SENSORS report with evidence hash', async () => {
    const http = new MockHttpClient([{ status: 200, data: { readings: READINGS } }]);
    const report = await aggregateIotProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http });

    expect(report.project_id).toBe('VCS-1234');
    expect(report.methodology).toBe('IOT_SENSORS');
    expect(report.period_start).toBe('2025-01-01');
    expect(report.period_end).toBe('2025-03-31');
    expect(report.ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(report.evidence.sensor_sample_count).toBe(3);
    expect(report.evidence.sensor_device_count).toBe(2);
    expect(report.evidence.soil_carbon_delta_ppm).toBe(150);
    expect(report.carbon_sequestered).toBeCloseTo(
      150 * PROJECT.area_ha * KG_CO2E_PER_HA_PER_PPM,
    );
  });

  it('meanSoilCarbonDeltaPpm averages per-device first/last deltas', () => {
    expect(meanSoilCarbonDeltaPpm(READINGS as any)).toBe(150);
    expect(meanSoilCarbonDeltaPpm([READINGS[0]] as any)).toBeNull();
  });

  it('floors carbon_sequestered at zero for a net soil-carbon loss period', async () => {
    // NBS-SOIL-001 loses soil carbon over the period (4350 -> 4200 ppm),
    // producing a negative delta. OracleConsumer.submit_report rejects
    // carbon_sequestered < 0, so the report must clamp it to zero while
    // still surfacing the raw negative delta in evidence for context.
    const lossReadings = [
      { ...READINGS[0], timestamp: '2025-02-15T06:00:00Z', metrics: { ...READINGS[0].metrics, soil_carbon_ppm: 4350 } },
      { ...READINGS[0], timestamp: '2025-03-15T06:00:00Z', metrics: { ...READINGS[0].metrics, soil_carbon_ppm: 4200 } },
    ];
    const http = new MockHttpClient([{ status: 200, data: { readings: lossReadings } }]);
    const report = await aggregateIotProject(
      { ...PROJECT, device_ids: ['NBS-SOIL-001'] },
      PERIOD,
      { baseUrl: BASE_URL, http },
    );

    expect(report.evidence.soil_carbon_delta_ppm).toBe(-150);
    expect(report.carbon_sequestered).toBe(0);
    expect(report.carbon_sequestered).toBeGreaterThanOrEqual(0);
  });

  it('throws IotSchemaError when a reading violates the schema', async () => {
    const http = new MockHttpClient([
      {
        status: 200,
        data: {
          readings: [{ ...READINGS[0], metrics: { ...READINGS[0].metrics, temperature: 999 } }],
        },
      },
    ]);
    await expect(
      aggregateIotProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(IotSchemaError);
  });

  it('throws IotNoValidReadingsError when no readings carry soil carbon or water table', async () => {
    const http = new MockHttpClient([
      {
        status: 200,
        data: {
          readings: [
            {
              ...READINGS[0],
              metrics: { ...READINGS[0].metrics, soil_carbon_ppm: null, water_table_cm: null },
            },
          ],
        },
      },
    ]);
    await expect(
      aggregateIotProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(IotNoValidReadingsError);
  });

  it('throws IotNoSoilCarbonDeltaError when devices lack start/end pairs', async () => {
    const http = new MockHttpClient([
      { status: 200, data: { readings: [READINGS[0]] } },
    ]);
    await expect(
      aggregateIotProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(IotNoSoilCarbonDeltaError);
  });

  it('throws IotAdapterError on a non-2xx upstream response', async () => {
    const http = new MockHttpClient([{ status: 500, data: {} }]);
    await expect(
      aggregateIotProject(PROJECT, PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(IotAdapterError);
  });

  it('rejects an invalid project configuration', async () => {
    const http = new MockHttpClient([{ status: 200, data: { readings: READINGS } }]);
    await expect(
      aggregateIotProject(
        { ...PROJECT, device_ids: [] },
        PERIOD,
        { baseUrl: BASE_URL, http },
      ),
    ).rejects.toThrow();
  });
});
