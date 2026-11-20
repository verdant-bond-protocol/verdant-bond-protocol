import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IpfsService, PinVerification } from './ipfs.service';
import { RedisService } from '../common/services/redis.service';

const TRACKED_KEY = 'ipfs:tracked-hashes';

/**
 * Periodic redundant-pin health verification (issue #211).
 *
 * Every document hash recorded via `track()` is fetched from each
 * configured pinning provider gateway on a schedule and checked for
 * retrievability (and hash-match when a digest was recorded). A failing
 * provider is re-pinned automatically; if the re-pin also fails an
 * escalation error is logged so operators can intervene (see
 * `docs/ipfs-pinning-runbook.md`).
 */
@Injectable()
export class IpfsHealthService {
  private readonly logger = new Logger(IpfsHealthService.name);

  constructor(
    private readonly ipfs: IpfsService,
    private readonly redis: RedisService,
  ) {}

  async track(hash: string, sha256Hex?: string): Promise<void> {
    const tracked = await this.listTracked();
    if (!tracked.some((t) => t.hash === hash)) {
      tracked.push({ hash, sha256Hex });
      await this.redis.set(TRACKED_KEY, JSON.stringify(tracked));
    }
  }

  async listTracked(): Promise<{ hash: string; sha256Hex?: string }[]> {
    try {
      const raw = await this.redis.get(TRACKED_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  @Cron(process.env.IPFS_HEALTH_CRON || CronExpression.EVERY_HOUR)
  async verifyAll(): Promise<{ hash: string; checks: PinVerification[] }[]> {
    const tracked = await this.listTracked();
    const results: { hash: string; checks: PinVerification[] }[] = [];
    for (const { hash, sha256Hex } of tracked) {
      results.push({ hash, checks: await this.verifyOne(hash, sha256Hex) });
    }
    return results;
  }

  async verifyOne(hash: string, sha256Hex?: string): Promise<PinVerification[]> {
    const checks = await this.ipfs.verifyPin(hash, sha256Hex);
    for (const check of checks) {
      if (check.retrievable && check.hashMatches !== false) continue;
      // Escalation step 1: automatic re-pin of the failing provider.
      this.logger.warn(
        `IPFS pin unhealthy: hash=${hash} provider=${check.provider} ` +
          `retrievable=${check.retrievable} hashMatches=${check.hashMatches}; re-pinning`,
      );
      try {
        await this.ipfs.pin(hash);
      } catch (err: any) {
        // Escalation step 2: re-pin failed — operator intervention required.
        this.logger.error(
          `IPFS ESCALATION: hash=${hash} provider=${check.provider} still failing after re-pin: ${err?.message}. ` +
            `Follow docs/ipfs-pinning-runbook.md (re-pin manually, rotate provider credentials).`,
        );
      }
    }
    return checks;
  }
}
