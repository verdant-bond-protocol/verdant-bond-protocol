import * as fs from 'fs';
import * as path from 'path';
import { RepairCheckpoint, RepairRefusedError } from './repair-tool.interface';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** File-backed checkpoint/journal for repair runs (survives process restarts). */
export class RepairCheckpointStore {
  constructor(private readonly dir: string) {}

  static defaultDir(): string {
    return process.env.REPAIR_STATE_DIR || path.join(process.cwd(), 'data', 'repair');
  }

  private file(runId: string): string {
    if (!SAFE_ID.test(runId)) {
      throw new RepairRefusedError(`Unsafe run id "${runId}" (allowed: letters, digits, . _ -)`);
    }
    return path.join(this.dir, `${runId}.json`);
  }

  async save(checkpoint: RepairCheckpoint): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a half checkpoint.
    const target = this.file(checkpoint.runId);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(checkpoint, null, 2));
    fs.renameSync(temp, target);
  }

  async load(runId: string): Promise<RepairCheckpoint | null> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new RepairRefusedError(`Cannot read checkpoint "${runId}": ${(error as Error).message}`);
    }
    try {
      const parsed = JSON.parse(raw) as RepairCheckpoint;
      if (!parsed || !Array.isArray(parsed.steps) || typeof parsed.planDigest !== 'string') {
        throw new Error('missing steps or planDigest');
      }
      return parsed;
    } catch (error) {
      throw new RepairRefusedError(`Checkpoint "${runId}" is corrupt: ${(error as Error).message}`);
    }
  }

  async list(): Promise<RepairCheckpoint[]> {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: RepairCheckpoint[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.endsWith('.tmp.json')) continue;
      const checkpoint = await this.load(file.slice(0, -'.json'.length));
      if (checkpoint) out.push(checkpoint);
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
