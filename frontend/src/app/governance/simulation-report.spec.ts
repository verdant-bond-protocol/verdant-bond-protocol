import { outcomeText, parseSimulationReport } from './simulation-report';

describe('Governance simulation report', () => {
  const report = () => ({ version: 1, proposal_id: '338', ledger_sequence: 123, ledger_timestamp: 10,
    snapshot_sha256: 'a'.repeat(64), network_passphrase: 'Test network', authorization: 'Assumed',
    proposal: { contract: 'C...', method: 'set_parameter', args: [] },
    proposal_result: { status: 'success', value: 'Completed' },
    diffs: [{ label: 'Fee', explanation: 'Paid by holders', category: 'fees', unit: 'minor units',
      before: { status: 'success', value: '90071992547409930000' },
      after: { status: 'success', value: '90071992547409930001' }, changed: true }] });
  it('preserves large amounts without floating-point rounding', () => {
    expect(outcomeText(parseSimulationReport(JSON.stringify(report())).diffs[0].before)).toBe('90071992547409930000');
  });
  it('rejects unsupported reports and contradictory change flags', () => {
    expect(() => parseSimulationReport('{}')).toThrow();
    const input = report(); input.diffs[0].changed = false;
    expect(() => parseSimulationReport(JSON.stringify(input))).toThrow();
  });
  it('makes contract failure explicit rather than showing a zero', () => {
    expect(outcomeText({ status: 'failure', error: 'Stale oracle' })).toContain('Could not execute');
  });
  for (const category of ['fees', 'covenants', 'oracle_config']) {
    it(`accepts ${category} before/after results`, () => {
      const input = report(); input.diffs[0].category = category;
      expect(parseSimulationReport(JSON.stringify(input)).diffs[0].category).toBe(category);
    });
  }
});
