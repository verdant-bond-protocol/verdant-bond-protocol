import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DexService } from './dex.service';
import { RedisService } from '../common/services/redis.service';

const CURSOR_KEY = 'dex:clean_expired:cursor';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES_PER_RUN = 20;

/**
 * Drives the on-chain batched `clean_expired_orders(start_id, limit)` interface.
 * Persists a cursor in Redis so each cron tick resumes where the previous left off
 * instead of restarting a full order-ID scan.
 */
@Injectable()
export class DexScheduler {
  private readonly logger = new Logger(DexScheduler.name);

  constructor(
    private readonly dexService: DexService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanExpiredOrders(): Promise<void> {
    if (!process.env.DEX_ROUTER_ADDRESS) {
      this.logger.debug('Skipping expired-order cleanup: DEX_ROUTER_ADDRESS unset');
      return;
    }

    const batchSize = Number(process.env.DEX_CLEAN_BATCH_SIZE || DEFAULT_BATCH_SIZE);
    const maxBatches = Number(
      process.env.DEX_CLEAN_MAX_BATCHES || DEFAULT_MAX_BATCHES_PER_RUN,
    );

    let startId = Number((await this.redis.get(CURSOR_KEY)) || '1');
    if (!Number.isFinite(startId) || startId < 1) {
      startId = 1;
    }

    this.logger.log(
      `Expired-order cleanup started (start_id=${startId}, batch=${batchSize}, max_batches=${maxBatches})`,
    );

    let totalCleaned = 0;
    let batches = 0;

    try {
      while (batches < maxBatches) {
        const result = await this.dexService.cleanExpiredOrders(startId, batchSize);
        totalCleaned += result.cleaned;
        batches += 1;

        if (result.nextStartId === 0) {
          await this.redis.set(CURSOR_KEY, '1');
          this.logger.log(
            `Expired-order cleanup complete: cleaned=${totalCleaned} across ${batches} batch(es)`,
          );
          return;
        }

        startId = result.nextStartId;
        await this.redis.set(CURSOR_KEY, String(startId));
      }

      this.logger.log(
        `Expired-order cleanup paused at cursor=${startId}: cleaned=${totalCleaned} across ${batches} batch(es)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Expired-order cleanup error: ${message}`);
    }
  }
}
