// Issue #467: Build ledger backfill tool with checkpoint and duplicate detection
// Backfills missing ledger entries with progress checkpoints and duplicate prevention

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

/**
 * Ledger entry structure
 */
export interface LedgerEntry {
  id: string;
  timestamp: string;
  bondId: string;
  action: 'issue' | 'transfer' | 'redeem' | 'coupon_payment';
  amount?: string;
  from?: string;
  to?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Checkpoint for backfill progress
 */
export interface BackfillCheckpoint {
  lastProcessedId: string;
  lastProcessedTimestamp: string;
  processedCount: number;
  duplicatesSkipped: number;
  errorsEncountered: number;
  checkpointTimestamp: string;
}

/**
 * Backfill configuration
 */
export interface BackfillConfig {
  /** Source of entries to backfill (file path, API endpoint, etc.) */
  source: string;
  /** Target ledger destination */
  target: string;
  /** Checkpoint file path for progress tracking */
  checkpointPath: string;
  /** Batch size for processing entries */
  batchSize: number;
  /** Enable duplicate detection using content hash */
  enableDuplicateDetection: boolean;
  /** Dry run mode (don't write to target) */
  dryRun: boolean;
}

/**
 * Backfill result statistics
 */
export interface BackfillResult {
  success: boolean;
  totalProcessed: number;
  duplicatesSkipped: number;
  errorsEncountered: number;
  startTime: string;
  endTime: string;
  duration: number;
  lastCheckpoint?: BackfillCheckpoint;
}

/**
 * Duplicate detector using content-based hashing
 */
class DuplicateDetector {
  private hashes: Set<string> = new Set();

  /**
   * Generate content hash for a ledger entry
   */
  private hashEntry(entry: LedgerEntry): string {
    const canonical = JSON.stringify({
      bondId: entry.bondId,
      action: entry.action,
      timestamp: entry.timestamp,
      amount: entry.amount,
      from: entry.from,
      to: entry.to,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Check if entry is a duplicate
   */
  isDuplicate(entry: LedgerEntry): boolean {
    const hash = this.hashEntry(entry);
    return this.hashes.has(hash);
  }

  /**
   * Mark entry as seen
   */
  markSeen(entry: LedgerEntry): void {
    const hash = this.hashEntry(entry);
    this.hashes.add(hash);
  }

  /**
   * Load existing hashes from target ledger
   */
  async loadExistingHashes(entries: LedgerEntry[]): Promise<void> {
    for (const entry of entries) {
      this.markSeen(entry);
    }
  }

  /**
   * Get statistics
   */
  getStats(): { uniqueEntries: number } {
    return { uniqueEntries: this.hashes.size };
  }
}

/**
 * Checkpoint manager for backfill progress
 */
class CheckpointManager {
  constructor(private checkpointPath: string) {}

  /**
   * Load checkpoint from file
   */
  async load(): Promise<BackfillCheckpoint | null> {
    try {
      const data = await fs.readFile(this.checkpointPath, 'utf-8');
      return JSON.parse(data) as BackfillCheckpoint;
    } catch (error) {
      // No checkpoint file exists yet
      return null;
    }
  }

  /**
   * Save checkpoint to file
   */
  async save(checkpoint: BackfillCheckpoint): Promise<void> {
    const dir = path.dirname(this.checkpointPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.checkpointPath,
      JSON.stringify(checkpoint, null, 2),
      'utf-8',
    );
  }

  /**
   * Clear checkpoint file
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.checkpointPath);
    } catch {
      // File doesn't exist, nothing to clear
    }
  }
}

/**
 * Ledger backfill tool
 * 
 * Features:
 * - Progress checkpointing for resumable backfills
 * - Duplicate detection using content-based hashing
 * - Batch processing for efficiency
 * - Dry run mode for validation
 * - Error handling and recovery
 */
export class LedgerBackfillTool {
  private duplicateDetector: DuplicateDetector;
  private checkpointManager: CheckpointManager;
  private config: BackfillConfig;

  constructor(config: BackfillConfig) {
    this.config = config;
    this.duplicateDetector = new DuplicateDetector();
    this.checkpointManager = new CheckpointManager(config.checkpointPath);
  }

  /**
   * Run the backfill process
   */
  async run(): Promise<BackfillResult> {
    const startTime = new Date().toISOString();
    let totalProcessed = 0;
    let duplicatesSkipped = 0;
    let errorsEncountered = 0;

    try {
      // Load checkpoint if exists
      const checkpoint = await this.checkpointManager.load();
      console.log(
        checkpoint
          ? `Resuming from checkpoint: ${checkpoint.lastProcessedId}`
          : 'Starting new backfill',
      );

      // Load source entries
      const sourceEntries = await this.loadSourceEntries();
      console.log(`Loaded ${sourceEntries.length} entries from source`);

      // Load existing target entries for duplicate detection
      if (this.config.enableDuplicateDetection) {
        const targetEntries = await this.loadTargetEntries();
        await this.duplicateDetector.loadExistingHashes(targetEntries);
        console.log(
          `Loaded ${targetEntries.length} existing entries for duplicate detection`,
        );
      }

      // Filter entries after checkpoint
      let entriesToProcess = sourceEntries;
      if (checkpoint) {
        const checkpointIndex = sourceEntries.findIndex(
          (e) => e.id === checkpoint.lastProcessedId,
        );
        if (checkpointIndex >= 0) {
          entriesToProcess = sourceEntries.slice(checkpointIndex + 1);
        }
      }

      console.log(`Processing ${entriesToProcess.length} entries`);

      // Process in batches
      const batches = this.createBatches(entriesToProcess, this.config.batchSize);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`Processing batch ${i + 1}/${batches.length}`);

        for (const entry of batch) {
          try {
            // Check for duplicates
            if (
              this.config.enableDuplicateDetection &&
              this.duplicateDetector.isDuplicate(entry)
            ) {
              duplicatesSkipped++;
              continue;
            }

            // Process entry
            if (!this.config.dryRun) {
              await this.writeToTarget(entry);
            }

            this.duplicateDetector.markSeen(entry);
            totalProcessed++;

            // Save checkpoint every batch
            if (totalProcessed % this.config.batchSize === 0) {
              await this.saveCheckpoint(
                entry,
                totalProcessed,
                duplicatesSkipped,
                errorsEncountered,
              );
            }
          } catch (error) {
            errorsEncountered++;
            console.error(`Error processing entry ${entry.id}:`, error);
            // Continue with next entry
          }
        }

        // Save checkpoint after each batch
        if (batch.length > 0) {
          await this.saveCheckpoint(
            batch[batch.length - 1],
            totalProcessed,
            duplicatesSkipped,
            errorsEncountered,
          );
        }
      }

      const endTime = new Date().toISOString();
      const duration = new Date(endTime).getTime() - new Date(startTime).getTime();

      console.log('Backfill completed successfully');
      console.log(`Total processed: ${totalProcessed}`);
      console.log(`Duplicates skipped: ${duplicatesSkipped}`);
      console.log(`Errors encountered: ${errorsEncountered}`);

      return {
        success: true,
        totalProcessed,
        duplicatesSkipped,
        errorsEncountered,
        startTime,
        endTime,
        duration,
      };
    } catch (error) {
      const endTime = new Date().toISOString();
      const duration = new Date(endTime).getTime() - new Date(startTime).getTime();

      console.error('Backfill failed:', error);

      return {
        success: false,
        totalProcessed,
        duplicatesSkipped,
        errorsEncountered,
        startTime,
        endTime,
        duration,
      };
    }
  }

  /**
   * Load entries from source
   */
  private async loadSourceEntries(): Promise<LedgerEntry[]> {
    // Implementation depends on source type (file, API, database)
    // For now, assume JSON file
    try {
      const data = await fs.readFile(this.config.source, 'utf-8');
      return JSON.parse(data) as LedgerEntry[];
    } catch (error) {
      throw new Error(`Failed to load source entries: ${error}`);
    }
  }

  /**
   * Load entries from target
   */
  private async loadTargetEntries(): Promise<LedgerEntry[]> {
    try {
      const data = await fs.readFile(this.config.target, 'utf-8');
      return JSON.parse(data) as LedgerEntry[];
    } catch {
      // Target doesn't exist yet
      return [];
    }
  }

  /**
   * Write entry to target
   */
  private async writeToTarget(entry: LedgerEntry): Promise<void> {
    // Implementation depends on target type
    // For now, append to JSON file
    try {
      let entries: LedgerEntry[] = [];
      try {
        const data = await fs.readFile(this.config.target, 'utf-8');
        entries = JSON.parse(data) as LedgerEntry[];
      } catch {
        // File doesn't exist, start fresh
      }

      entries.push(entry);

      const dir = path.dirname(this.config.target);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        this.config.target,
        JSON.stringify(entries, null, 2),
        'utf-8',
      );
    } catch (error) {
      throw new Error(`Failed to write entry to target: ${error}`);
    }
  }

  /**
   * Save checkpoint
   */
  private async saveCheckpoint(
    lastEntry: LedgerEntry,
    processedCount: number,
    duplicatesSkipped: number,
    errorsEncountered: number,
  ): Promise<void> {
    const checkpoint: BackfillCheckpoint = {
      lastProcessedId: lastEntry.id,
      lastProcessedTimestamp: lastEntry.timestamp,
      processedCount,
      duplicatesSkipped,
      errorsEncountered,
      checkpointTimestamp: new Date().toISOString(),
    };

    await this.checkpointManager.save(checkpoint);
  }

  /**
   * Create batches from entries
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Clear checkpoint and start fresh
   */
  async resetCheckpoint(): Promise<void> {
    await this.checkpointManager.clear();
  }
}

/**
 * CLI entry point for ledger backfill
 */
export async function runBackfillCLI(args: {
  source: string;
  target: string;
  checkpoint?: string;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<void> {
  const config: BackfillConfig = {
    source: args.source,
    target: args.target,
    checkpointPath: args.checkpoint || './backfill-checkpoint.json',
    batchSize: args.batchSize || 100,
    enableDuplicateDetection: true,
    dryRun: args.dryRun || false,
  };

  const tool = new LedgerBackfillTool(config);
  const result = await tool.run();

  if (!result.success) {
    process.exit(1);
  }
}
