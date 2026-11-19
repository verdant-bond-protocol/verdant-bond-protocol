import * as fs from 'fs';
import * as path from 'path';
import {
  checkStorageMigrationCompatibility,
  StorageCompatInputs,
} from './storage-schema-compat';

interface CompatFixtureCase extends StorageCompatInputs {
  expectedOk: boolean;
}

interface CompatFixtureFile {
  version: string;
  fixtures: Record<string, CompatFixtureCase>;
}

describe('Versioned migration notes and compatibility fixtures (#527)', () => {
  const fixturePath = path.resolve(__dirname, '../../testdata/migrations/v1-v2-compat-fixtures.json');
  const loaded = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as CompatFixtureFile;

  it('normal path: additive and planned v1->v2 compatibility fixtures pass', () => {
    const additive = loaded.fixtures.compatible_additive;
    const additiveReport = checkStorageMigrationCompatibility(additive);
    expect(additiveReport.compatible).toBe(additive.expectedOk);
    expect(additiveReport.violations).toHaveLength(0);

    const planned = loaded.fixtures.breaking_valid_with_plan;
    const plannedReport = checkStorageMigrationCompatibility(planned);
    expect(plannedReport.compatible).toBe(planned.expectedOk);
    expect(plannedReport.violations).toHaveLength(0);
  });

  it('failure path: version skip without migration plan fails compatibility check', () => {
    const skip = loaded.fixtures.breaking_version_skip;
    const report = checkStorageMigrationCompatibility(skip);
    expect(report.compatible).toBe(false);
    expect(report.violations.some((v) => v.code === 'VERSION_SKIP')).toBe(true);
  });

  it('authorization path: migration step missing governanceGated=true is rejected', () => {
    const unauthorized = loaded.fixtures.breaking_missing_governance_gate;
    const report = checkStorageMigrationCompatibility(unauthorized);
    expect(report.compatible).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
  });

  it('retry path: re-running compatibility check is deterministic and idempotent', () => {
    const planned = loaded.fixtures.breaking_valid_with_plan;
    const first = checkStorageMigrationCompatibility(planned);
    const second = checkStorageMigrationCompatibility(planned);
    expect(first).toEqual(second);
  });
});
