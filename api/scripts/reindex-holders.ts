#!/usr/bin/env node
/**
 * Operational repair tool (#117): reindex authoritative bond holder state
 * against on-chain balances.
 *
 * Use this after Redis loss or when direct contract transfers may have
 * occurred outside the API, so the durable holder index is brought back in
 * line with the ledger. Holder membership is stored in a Redis-independent
 * durable store (see HolderIndexService), so this rebuilds that store.
 *
 * Usage:
 *   npm run reindex-holders                 # reindex every known bond
 *   npm run reindex-holders -- --bond 3     # reindex a single bond
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommonModule } from '../src/common/common.module';
import { BondsModule } from '../src/bonds/bonds.module';
import { BondsService } from '../src/bonds/bonds.service';

@Module({
  imports: [CommonModule, BondsModule],
})
class ReindexContextModule {}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bondArg = argv.find((a) => a.startsWith('--bond'));
  const bondId = bondArg ? Number(bondArg.split('=')[1]) : undefined;

  const app = await NestFactory.createApplicationContext(ReindexContextModule, {
    logger: ['error', 'warn', 'log'],
  });
  const bondsService = app.get(BondsService);

  try {
    if (bondId && !Number.isNaN(bondId)) {
      const result = await bondsService.reconcileBond(bondId);
      console.log(`Reconciled bond ${bondId}: ${result.total} holder(s).`);
    } else {
      const results = await bondsService.reindexHolders();
      console.log(`Reindexed ${results.length} bond(s):`);
      for (const r of results) {
        console.log(`  bond ${r.bondId}: ${r.total} holder(s)`);
      }
    }
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error('Reindex failed:', error instanceof Error ? error.message : error);
    await app.close();
    process.exit(1);
  }
}

main();
