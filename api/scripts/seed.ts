#!/usr/bin/env node
/**
 * Deterministic local seed data for Verdant Bond Protocol.
 *
 * Populates the Redis cache keys the API reads (projects, bonds, orders,
 * oracle reports) with realistic fixtures so the local frontend shows
 * meaningful data without deployed contracts.
 *
 * Usage:
 *   npm run seed                 # apply fixtures (idempotent; skips if done)
 *   npm run seed -- --force      # always re-apply fixtures
 *   npm run seed -- --reset      # clear all seeded keys
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommonModule } from '../src/common/common.module';
import { SeedModule } from '../src/seed/seed.module';
import { SeedService } from '../src/seed/seed.service';

@Module({
  imports: [CommonModule, SeedModule],
})
class SeedContextModule {}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const reset = argv.includes('--reset');

  const app = await NestFactory.createApplicationContext(SeedContextModule, {
    logger: ['error', 'warn', 'log'],
  });
  const seedService = app.get(SeedService);

  try {
    if (reset) {
      await seedService.reset();
      console.log('Seed data cleared.');
    } else {
      const summary = await seedService.seed(force);
      if (summary.wasSkipped) {
        console.log('Already seeded. Run `npm run seed -- --force` to reseed.');
      } else {
        console.log(
          `Seeded ${summary.totals.bonds} bonds, ${summary.totals.projects} projects, ` +
            `${summary.totals.orders} orders, ${summary.totals.oracleReports} oracle reports, ` +
            `${summary.totals.cacheKeysWritten} cache keys.`,
        );
      }
    }
    await app.close();
  } finally {
    process.exit(0);
  }
}

main().catch(async (error) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
  process.exit(1);
});
