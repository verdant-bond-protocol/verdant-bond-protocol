import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from './redis.service';

@Injectable()
export class NonceService {
  private readonly logger = new Logger(NonceService.name);
  constructor(private readonly redis: RedisService) {}

  async withNonce<T>(
    contractAddress: string,
    address: string,
    getContractNonce: () => Promise<number>,
    operation: (nonce: number) => Promise<T>,
  ): Promise<T> {
    const cursorKey = `nonce:${contractAddress}:${address}`;
    const lockKey = `${cursorKey}:lock`;
    const token = randomUUID();
    await this.acquire(lockKey, token);

    try {
      const cached = await this.redis.getOrThrow(cursorKey);
      const contractNonce = await getContractNonce();
      const nonce = Number(cached);

      if (!Number.isSafeInteger(contractNonce) || contractNonce < 0) {
        throw new ServiceUnavailableException('Contract nonce is invalid');
      }
      if (cached === null || nonce !== contractNonce) {
        await this.redis.setOrThrow(cursorKey, String(contractNonce));
        this.logger.log(
          `nonce contract-state resync contract=${contractAddress} address=${address} nonce=${contractNonce}`,
        );
      }

      this.logger.log(`nonce allocation contract=${contractAddress} address=${address} nonce=${contractNonce}`);

      try {
        const result = await operation(contractNonce);
        await this.redis.setOrThrow(cursorKey, String(contractNonce + 1));
        this.logger.log(`nonce commit contract=${contractAddress} address=${address} nonce=${contractNonce}`);
        return result;
      } catch (error) {
        this.logger.warn(`nonce rollback contract=${contractAddress} address=${address} nonce=${contractNonce}`);
        await this.resync(cursorKey, contractAddress, address, getContractNonce, error);
        throw error;
      }
    } finally {
      await this.redis.releaseLockOrThrow(lockKey, token);
    }
  }

  private async acquire(key: string, token: string): Promise<void> {
    const timeoutMs = this.positiveInteger(process.env.NONCE_LOCK_WAIT_MS, 180_000);
    const ttlMs = this.positiveInteger(process.env.NONCE_LOCK_TTL_MS, 300_000);
    const retryMs = this.positiveInteger(process.env.NONCE_LOCK_RETRY_MS, 50);
    const deadline = Date.now() + timeoutMs;

    while (!(await this.redis.acquireLockOrThrow(key, token, ttlMs))) {
      if (Date.now() >= deadline) {
        throw new ServiceUnavailableException('Timed out waiting for nonce reservation');
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  private async resync(
    cursorKey: string,
    contractAddress: string,
    address: string,
    getContractNonce: () => Promise<number>,
    originalError: unknown,
  ): Promise<void> {
    try {
      const contractNonce = await getContractNonce();
      await this.redis.setOrThrow(cursorKey, String(contractNonce));
      this.logger.log(
        `nonce contract-state resync contract=${contractAddress} address=${address} nonce=${contractNonce}`,
      );
    } catch (resyncError) {
      this.logger.error(
        `nonce contract-state resync failed contract=${contractAddress} address=${address}: ${this.message(resyncError)}`,
      );
      if (!(originalError instanceof Error)) {
        throw resyncError;
      }
    }
  }

  private positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
