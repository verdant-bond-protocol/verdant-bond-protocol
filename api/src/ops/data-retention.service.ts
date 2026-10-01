import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';

export enum DataType {
  TELEMETRY = 'telemetry',
  EXPORT = 'exports',
  EVIDENCE = 'evidence',
  AUDIT = 'kyc',
}

export const RETENTION_DAYS: Record<DataType, number> = {
  [DataType.TELEMETRY]: 30,
  [DataType.EXPORT]: 7,
  [DataType.EVIDENCE]: 365 * 5, // 5 years
  [DataType.AUDIT]: 365 * 7,    // 7 years
};

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);
  private readonly dataDir: string;
  private readonly fileFs: typeof fs.promises;

  constructor(private readonly oracleIncidents: OracleIncidentRepository) {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.fileFs = fs.promises;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runCleanupJob(): Promise<void> {
    this.logger.log('Starting data retention cleanup job...');
    const now = Date.now();

    for (const type of Object.values(DataType)) {
      const dirPath = path.join(this.dataDir, type);
      await this.cleanupDirectory(dirPath, type, now);
    }
    
    this.logger.log('Data retention cleanup job finished.');
  }

  private async cleanupDirectory(dirPath: string, type: DataType, now: number): Promise<void> {
    try {
      const stats = await this.fileFs.stat(dirPath);
      if (!stats.isDirectory()) return;
    } catch (e) {
      // Directory doesn't exist, nothing to clean up
      return;
    }

    const files = await this.fileFs.readdir(dirPath);
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const fileStats = await this.fileFs.stat(filePath);
        if (fileStats.isFile()) {
          const ageInDays = (now - fileStats.mtimeMs) / (1000 * 60 * 60 * 24);
          const retentionLimit = RETENTION_DAYS[type];

          if (ageInDays > retentionLimit) {
            const protectedRecord = await this.isProtected(type, file);
            if (protectedRecord) {
              this.logger.log(`Skipping protected ${type} record: ${file}`);
              continue;
            }

            this.logger.log(`Deleting expired ${type} record: ${file} (Age: ${ageInDays.toFixed(1)} days)`);
            await this.fileFs.unlink(filePath);
            deletedCount++;
          }
        }
      } catch (err) {
        this.logger.error(`Error processing file ${filePath}: ${err}`);
      }
    }
    
    if (deletedCount > 0) {
      this.logger.log(`Deleted ${deletedCount} eligible records from ${type}.`);
    }
  }

  private async isProtected(type: DataType, filename: string): Promise<boolean> {
    if (type !== DataType.EVIDENCE) return false;

    // For evidence, check if it relates to an active oracle incident
    try {
      const activeIncidents = await this.oracleIncidents.findMany(1, 1000, 'active');
      const acknowledgedIncidents = await this.oracleIncidents.findMany(1, 1000, 'acknowledged');
      const allActive = [...activeIncidents.data, ...acknowledgedIncidents.data];
      
      // Assume the filename might contain the IPFS hash or UUID related to the incident
      for (const incident of allActive) {
        if (filename.includes(incident.subjectId) || filename.includes(incident.id)) {
          return true;
        }
      }
    } catch (err) {
      this.logger.warn(`Could not check protection status for evidence ${filename}: ${err}`);
      // Protect it if we can't verify
      return true;
    }
    return false;
  }
}
