import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { OracleService } from './oracle.service';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { VerraProvider } from './providers/verra.provider';
import { SatelliteProvider } from './providers/satellite.provider';
import { BlueCarbonProvider } from './providers/blue-carbon.provider';
import { MeasurementData, OracleProviderAdapter } from './providers/provider.interface';

@Injectable()
export class OracleScheduler {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly monitoringService: OracleMonitoringService,
    private readonly verraProvider: VerraProvider,
    private readonly satelliteProvider: SatelliteProvider,
    private readonly blueCarbonProvider: BlueCarbonProvider,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollOracleData(): Promise<void> {
    this.logger.log('Oracle poll cycle started');

    try {
      const providers = [
        this.verraProvider,
        this.satelliteProvider,
        this.blueCarbonProvider,
      ];

      for (const provider of providers) {
        await this.pollProvider(provider);
      }
    } catch (error) {
      this.logger.error(`Oracle poll cycle error: ${error.message}`);
    }

    this.logger.log('Oracle poll cycle completed');
  }

  @Cron('0 */6 * * *')
  async monitorProviderReliability(): Promise<void> {
    this.logger.log('Oracle reliability monitoring cycle started');

    try {
      const alerted = await this.monitoringService.alertStaleProjects();
      this.logger.log(
        `Oracle reliability monitoring cycle completed: ${alerted} alert(s) emitted`,
      );
    } catch (error) {
      this.logger.error(`Oracle reliability monitoring error: ${error.message}`);
    }
  }

  private async pollProvider(provider: OracleProviderAdapter): Promise<void> {
    const projects = this.pollProjectIds();
    if (projects.length === 0) {
      this.logger.warn('Oracle poll skipped: ORACLE_POLL_PROJECT_IDS is empty');
      return;
    }

    const providerAddress = this.providerAddressFor(provider);
    if (!providerAddress) {
      this.logger.warn(`Oracle poll skipped for ${provider.name}: missing provider address`);
      return;
    }

    for (const projectId of projects) {
      try {
        this.logger.debug?.(`Polling provider ${provider.name} for project ${projectId}`);
        const measurement = await provider.fetchMeasurement(projectId);
        this.validateMeasurement(provider, measurement);
        const report = await this.oracleService.submitReport(
          this.toSubmitReport(provider, measurement),
          providerAddress,
        );
        this.logger.debug?.(
          `Oracle poll submitted report ${report.id} for ${provider.name}/${projectId}`,
        );
      } catch (error) {
        this.logger.warn(
          `Oracle poll failed for ${provider.name}/${projectId}: ${this.normalizeError(error)}`,
        );
      }
    }
  }

  private pollProjectIds(): string[] {
    return (process.env.ORACLE_POLL_PROJECT_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private providerAddressFor(provider: OracleProviderAdapter): string {
    const raw = process.env.ORACLE_PROVIDER_ADDRESSES;
    if (raw) {
      try {
        const addresses = JSON.parse(raw) as Record<string, string>;
        return addresses[provider.name] || addresses[provider.methodology] || '';
      } catch (error) {
        this.logger.warn(`Invalid ORACLE_PROVIDER_ADDRESSES JSON: ${this.normalizeError(error)}`);
      }
    }
    return process.env.DEFAULT_PROVIDER_ADDRESS || '';
  }

  private validateMeasurement(provider: OracleProviderAdapter, measurement: MeasurementData): void {
    if (!measurement.projectId) {
      throw new Error('measurement projectId is required');
    }
    if (!(measurement.periodStart instanceof Date) || Number.isNaN(measurement.periodStart.getTime())) {
      throw new Error('measurement periodStart must be a valid Date');
    }
    if (!(measurement.periodEnd instanceof Date) || Number.isNaN(measurement.periodEnd.getTime())) {
      throw new Error('measurement periodEnd must be a valid Date');
    }
    if (measurement.periodEnd <= measurement.periodStart) {
      throw new Error('measurement periodEnd must be after periodStart');
    }
    if (!Number.isFinite(measurement.carbonSequesteredKg) || measurement.carbonSequesteredKg < 0) {
      throw new Error('measurement carbonSequesteredKg must be non-negative');
    }
    if (!Number.isFinite(measurement.confidence) || measurement.confidence < 0 || measurement.confidence > 1) {
      throw new Error('measurement confidence must be between 0 and 1');
    }
    if (!Array.isArray(measurement.evidenceHashes) || measurement.evidenceHashes.length === 0) {
      throw new Error(`measurement evidenceHashes are required for ${provider.name}`);
    }
  }

  private toSubmitReport(provider: OracleProviderAdapter, measurement: MeasurementData) {
    const evidenceHash = createHash('sha256')
      .update(JSON.stringify({
        provider: provider.name,
        methodology: provider.methodology,
        projectId: measurement.projectId,
        evidenceHashes: measurement.evidenceHashes,
      }))
      .digest('hex');

    return {
      projectId: measurement.projectId,
      periodStart: Math.floor(measurement.periodStart.getTime() / 1000),
      periodEnd: Math.floor(measurement.periodEnd.getTime() / 1000),
      carbonSequestered: Math.round(measurement.carbonSequesteredKg),
      methodology: provider.methodology,
      evidenceHash,
    };
  }

  private normalizeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
