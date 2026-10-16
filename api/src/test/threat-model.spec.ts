/**
 * Keeps docs/security/cross-boundary-threat-model.md honest (#347): every check
 * a threat row cites must exist, and every High-risk threat must cite one.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MODEL = readFileSync(join(REPO_ROOT, 'docs/security/cross-boundary-threat-model.md'), 'utf8');

const rows = MODEL.split('\n')
  .filter((line) => /^\| TM-\d+ \|/.test(line))
  .map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return {
      id: cells[1],
      risk: cells[4],
      checks: [...cells[6].matchAll(/`([^`]+\.ts)`/g)].map((m) => m[1]),
    };
  });

describe('cross-boundary threat model traceability', () => {
  it('parses the threat register', () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it.each(rows.map((r) => [r.id, r] as const))('%s cites only checks that exist', (_id, row) => {
    for (const check of row.checks) expect(existsSync(join(REPO_ROOT, check))).toBe(true);
  });

  it.each(rows.filter((r) => r.risk === 'High').map((r) => [r.id, r] as const))(
    '%s (High) is guarded by at least one executable check',
    (_id, row) => {
      expect(row.checks.length).toBeGreaterThan(0);
    },
  );
});
