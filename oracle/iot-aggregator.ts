import { z } from 'zod';
import { createAxiosHttpClient, HttpClient } from './http';
import { buildOracleReport } from './report';
import {
  IoTReadingListSchema,
  IotProjectConfigSchema,
  IotProjectConfig,
  IoTSensorReading,
  METHODOLOGY,
} from './schemas';

const DEFAULT_IOT_URL = process.env.IOT_API_URL || 'https://api.iot-sensor-network.io/v1';

export interface IotAdapterOptions {
  baseUrl?: string;
  http?: HttpClient;
  timeoutMs?: number;
}

export class IotAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IotAdapterError';
  }
}

export class IotSchemaError extends IotAdapterError {
  constructor(source: string, issues: z.ZodIssue[]) {
    super(`IoT response for ${source} failed schema validation: ${issues[0]?.message ?? 'unknown issue'}`);
    this.name = 'IotSchemaError';
  }
}

export class IotNoValidReadingsError extends IotAdapterError {
  constructor(deviceIds: string[], periodStart: string, periodEnd: string) {
    super(
      `No valid sensor readings for devices [${deviceIds.join(', ')}] in period ${periodStart}..${periodEnd}`,
    );
    this.name = 'IotNoValidReadingsError';
  }
}

export class IotNoSoilCarbonDeltaError extends IotAdapterError {
  constructor(deviceIds: string[]) {
    super(
      `No device reported soil carbon at both period start and end (devices: ${deviceIds.join(', ')})`,
    );
    this.name = 'IotNoSoilCarbonDeltaError';
  }
}

/** Validate a single in-situ reading against its documented schema. */
export function validateIotReading(reading: IoTSensorReading): boolean {
  return IoTReadingListSchema.safeParse({ readings: [reading] }).success;
}

export interface SensorAggregate {
  avgSoilMoisture: number | null;
  avgTemperature: number | null;
  avgHumidity: number | null;
  avgSoilCarbonPpm: number | null;
  avgWaterTableCm: number | null;
  sampleCount: number;
  deviceCount: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Aggregate validated in-situ sensor readings into period summary statistics.
 */
export function aggregateSensorReadings(readings: IoTSensorReading[]): SensorAggregate {
  const soilMoisture = readings.flatMap((r) => (r.metrics.soil_moisture !== null ? [r.metrics.soil_moisture] : []));
  const temperature = readings.flatMap((r) => (r.metrics.temperature !== null ? [r.metrics.temperature] : []));
  const humidity = readings.flatMap((r) => (r.metrics.humidity !== null ? [r.metrics.humidity] : []));
  const soilCarbon = readings.flatMap((r) => (r.metrics.soil_carbon_ppm !== null ? [r.metrics.soil_carbon_ppm] : []));
  const waterTable = readings.flatMap((r) => (r.metrics.water_table_cm !== null ? [r.metrics.water_table_cm] : []));

  return {
    avgSoilMoisture: mean(soilMoisture),
    avgTemperature: mean(temperature),
    avgHumidity: mean(humidity),
    avgSoilCarbonPpm: mean(soilCarbon),
    avgWaterTableCm: mean(waterTable),
    sampleCount: readings.length,
    deviceCount: new Set(readings.map((r) => r.device_id)).size,
  };
}

// Calibration constants for the soil-carbon proxy (documented in README).
const SOIL_BULK_DENSITY_KG_M3 = 1.4 * 1e3; // typical mineral soil bulk density
const SOIL_SAMPLE_DEPTH_M = 0.3; // IPCC default sampling depth
const KG_C_TO_KG_CO2E = 44 / 12;
/** kg CO2e per hectare per ppm of soil organic carbon (0.3 m depth). */
export const KG_CO2E_PER_HA_PER_PPM =
  1e-6 * SOIL_BULK_DENSITY_KG_M3 * SOIL_SAMPLE_DEPTH_M * 1e4 * KG_C_TO_KG_CO2E;

/**
 * Mean change in soil organic carbon (ppm) per device between the first and
 * last reading that reports `soil_carbon_ppm` within the period. Returns
 * `null` when no device provides a start/end pair.
 */
export function meanSoilCarbonDeltaPpm(readings: IoTSensorReading[]): number | null {
  const byDevice = new Map<string, Array<{ at: number; ppm: number }>>();
  for (const reading of readings) {
    if (reading.metrics.soil_carbon_ppm === null) continue;
    const at = Date.parse(reading.timestamp);
    const entry = { at, ppm: reading.metrics.soil_carbon_ppm };
    const existing = byDevice.get(reading.device_id);
    if (existing) existing.push(entry);
    else byDevice.set(reading.device_id, [entry]);
  }

  const deltas: number[] = [];
  for (const samples of byDevice.values()) {
    samples.sort((a, b) => a.at - b.at);
    if (samples.length >= 2) {
      deltas.push(samples[samples.length - 1].ppm - samples[0].ppm);
    }
  }
  if (deltas.length === 0) return null;
  return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
}

/**
 * Fetch in-situ readings for a set of devices over the period, validate each
 * reading, aggregate them, and produce an `OracleReport` with methodology
 * `IOT-SENSORS`.
 *
 * Carbon sequestration is the per-device mean change in soil organic carbon
 * (ppm) over the period, converted with `KG_CO2E_PER_HA_PER_PPM`. Devices
 * without both a period-start and period-end reading contribute no delta.
 */
export async function aggregateIotProject(
  project: IotProjectConfig,
  period: { periodStart: string; periodEnd: string },
  options: IotAdapterOptions = {},
): Promise<ReturnType<typeof buildOracleReport>> {
  const validatedProject = IotProjectConfigSchema.parse(project);
  const baseUrl = (options.baseUrl || DEFAULT_IOT_URL).replace(/\/$/, '');
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs);
  const { periodStart, periodEnd } = period;

  const deviceQuery = encodeURIComponent(validatedProject.device_ids.join(','));
  const response = await http.get<unknown>(
    `${baseUrl}/readings?devices=${deviceQuery}&start=${periodStart}&end=${periodEnd}`,
  );

  if (response.status < 200 || response.status >= 300) {
    throw new IotAdapterError(`IoT endpoint returned status ${response.status}`);
  }

  let parsed: z.infer<typeof IoTReadingListSchema>;
  try {
    parsed = IoTReadingListSchema.parse(response.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new IotSchemaError('readings', error.issues);
    }
    throw error;
  }

  const validReadings = parsed.readings.filter((reading) =>
    reading.metrics.soil_carbon_ppm !== null || reading.metrics.water_table_cm !== null,
  );
  if (validReadings.length === 0) {
    throw new IotNoValidReadingsError(validatedProject.device_ids, periodStart, periodEnd);
  }

  const soilCarbonDeltaPpm = meanSoilCarbonDeltaPpm(validReadings);
  if (soilCarbonDeltaPpm === null) {
    throw new IotNoSoilCarbonDeltaError(validatedProject.device_ids);
  }

  const aggregate = aggregateSensorReadings(validReadings);
  // Mirror blue-carbon-adapter.ts's floor: a period of net soil-carbon loss
  // yields a negative delta, and OracleConsumer.submit_report rejects
  // carbon_sequestered < 0 outright. Floor the reported value at zero so such
  // periods are handled gracefully. The raw (possibly negative) delta is still
  // surfaced in evidence.soil_carbon_delta_ppm to preserve carbon-loss context.
  const carbonSequestered = Math.max(
    0,
    soilCarbonDeltaPpm * validatedProject.area_ha * KG_CO2E_PER_HA_PER_PPM,
  );

  return buildOracleReport({
    project_id: validatedProject.project_id,
    provider: 'IotSensorNetwork',
    methodology: METHODOLOGY.IOT_SENSORS,
    period_start: periodStart,
    period_end: periodEnd,
    carbon_sequestered: carbonSequestered,
    confidence: 0.75,
    evidence: {
      sensor_sample_count: aggregate.sampleCount,
      sensor_device_count: aggregate.deviceCount,
      soil_carbon_delta_ppm: soilCarbonDeltaPpm,
      avg_soil_carbon_ppm: aggregate.avgSoilCarbonPpm,
      avg_water_table_cm: aggregate.avgWaterTableCm,
    },
    raw_observations: {
      device_ids: validatedProject.device_ids,
      sample_count: aggregate.sampleCount,
      device_count: aggregate.deviceCount,
    },
    transformation_parameters: {
      area_ha: validatedProject.area_ha,
      soil_carbon_delta_ppm: soilCarbonDeltaPpm,
      kg_co2e_per_ha_per_ppm: KG_CO2E_PER_HA_PER_PPM,
    },
  });
}
