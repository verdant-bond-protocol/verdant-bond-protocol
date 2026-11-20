import * as fs from 'fs';
import * as path from 'path';
import { RepairJob } from './repair-tool.interface';

interface HolderRecord {
  address: string;
  balance: string;
}

export type RepairJobFactory = (flags: Record<string, string | boolean>) => RepairJob;

/**
 * Reference repair job: merge duplicate holder addresses in a local JSON
 * snapshot, summing their (bigint) balances so no tokens are created or lost.
 * Every write has a before-image backup and a compensating rollback.
 */
export const holderDedupeJob: RepairJobFactory = (flags) => {
  const file = path.resolve(String(flags['file'] ?? path.join(process.cwd(), 'data', 'holders.json')));
  const backup = `${file}.repair-backup`;

  const read = (): HolderRecord[] => {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { holders: HolderRecord[] };
    if (!Array.isArray(parsed.holders)) throw new Error('snapshot has no holders array');
    return parsed.holders;
  };
  const write = (records: HolderRecord[]): void => {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ holders: records }, null, 2));
    fs.renameSync(temp, file);
  };
  const hasDuplicates = (): boolean => {
    const seen = new Set<string>();
    return read().some((r) => {
      if (seen.has(r.address)) return true;
      seen.add(r.address);
      return false;
    });
  };

  return {
    id: 'holders:dedupe',
    description: `merge duplicate holder addresses in ${file}`,
    steps: [
      {
        id: 'holders:dedupe:backup',
        description: 'save the before-image snapshot',
        inspect: () => fs.existsSync(backup),
        apply: () => fs.copyFileSync(file, backup),
        rollback: () => {
          if (fs.existsSync(backup)) fs.copyFileSync(backup, file);
        },
      },
      {
        id: 'holders:dedupe:merge',
        description: 'sum balances of duplicate addresses (conservation-preserving)',
        inspect: () => !hasDuplicates(),
        apply: () => {
          const totals = new Map<string, bigint>();
          for (const record of read()) {
            totals.set(record.address, (totals.get(record.address) ?? 0n) + BigInt(record.balance));
          }
          write([...totals].map(([address, balance]) => ({ address, balance: balance.toString() })));
        },
        rollback: () => {
          if (fs.existsSync(backup)) fs.copyFileSync(backup, file);
        },
      },
    ],
  };
};

export const DEFAULT_REPAIR_JOBS: Record<string, RepairJobFactory> = {
  'holders:dedupe': holderDedupeJob,
};
