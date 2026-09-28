import { buildSeedDataset } from './fixtures';

/**
 * Internal-consistency checks for the seed dataset (issue #304). These do
 * not touch Redis — they validate the plain fixture object so a bad edit to
 * `fixtures.ts` (a dangling foreign id, an out-of-order timestamp) is caught
 * without needing a running cache.
 */
describe('buildSeedDataset internal consistency', () => {
  const dataset = buildSeedDataset();

  it('has no duplicate ids within any collection', () => {
    const idsOf = <T extends { id: unknown }>(rows: T[]) => rows.map((r) => r.id);
    expect(new Set(idsOf(dataset.users)).size).toBe(dataset.users.length);
    expect(new Set(idsOf(dataset.projects)).size).toBe(dataset.projects.length);
    expect(new Set(idsOf(dataset.bonds)).size).toBe(dataset.bonds.length);
    expect(new Set(idsOf(dataset.orders)).size).toBe(dataset.orders.length);
    expect(new Set(idsOf(dataset.oracleReports)).size).toBe(dataset.oracleReports.length);
    expect(new Set(idsOf(dataset.authorizations)).size).toBe(dataset.authorizations.length);
  });

  it('every bond references a real project', () => {
    const projectIds = new Set(dataset.projects.map((p) => p.id));
    for (const bond of dataset.bonds) {
      expect(projectIds.has(bond.projectId)).toBe(true);
    }
  });

  it('every order references a real bond', () => {
    const bondIds = new Set(dataset.bonds.map((b) => b.id));
    for (const order of dataset.orders) {
      expect(bondIds.has(order.bondId)).toBe(true);
    }
  });

  it('every oracle report references a real project', () => {
    const projectIds = new Set(dataset.projects.map((p) => p.id));
    for (const report of dataset.oracleReports) {
      expect(projectIds.has(report.projectId)).toBe(true);
    }
  });

  it('every authorization references real users for its subject, grantor, and (when set) revoker', () => {
    const userIds = new Set(dataset.users.map((u) => u.address));
    for (const authorization of dataset.authorizations) {
      expect(userIds.has(authorization.subjectAddress)).toBe(true);
      expect(userIds.has(authorization.grantedBy)).toBe(true);
      if (authorization.revokedBy !== undefined) {
        expect(userIds.has(authorization.revokedBy)).toBe(true);
      }
    }
  });

  it('every bond keeps totalSubscribed within totalSupply, including the defaulted one', () => {
    for (const bond of dataset.bonds) {
      expect(bond.totalSubscribed).toBeLessThanOrEqual(bond.totalSupply);
    }
  });

  // ── Edge cases named in issue #304 ──────────────────────────────────────

  it('failed-settlement edge case: exactly one Defaulted bond exists, and it is Matured', () => {
    const defaulted = dataset.bonds.filter((b) => b.status === 'Defaulted');
    expect(defaulted).toHaveLength(1);
    expect(defaulted[0].maturityStatus).toBe('Matured');
  });

  it('revoked-access edge case: the revoked authorization was revoked strictly between its grant and its natural expiry', () => {
    const revoked = dataset.authorizations.find((a) => a.status === 'revoked');
    expect(revoked).toBeDefined();
    expect(revoked!.revokedAt).toBeGreaterThan(revoked!.grantedAt);
    expect(revoked!.revokedAt).toBeLessThan(revoked!.expiresAt);
  });

  it('overdue-workflow edge case: the fixture pending report is anchored before now, not just before BASE_TS', () => {
    const overdue = dataset.oracleReports.find((r) => r.id === 11);
    expect(overdue).toBeDefined();
    expect(overdue!.status).toBe('Pending');
    expect(overdue!.periodEnd).toBeLessThan(Date.now());
  });

  it('historical-records edge case: at least one Matured bond predates the fixture anchor date by years', () => {
    const historical = dataset.bonds.find((b) => b.name.includes('Legacy'));
    expect(historical).toBeDefined();
    expect(historical!.maturityStatus).toBe('Matured');
  });

  it('is deterministic: two builds produce byte-identical output', () => {
    expect(JSON.stringify(buildSeedDataset())).toEqual(JSON.stringify(buildSeedDataset()));
  });
});
