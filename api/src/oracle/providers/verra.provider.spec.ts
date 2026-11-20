import { VerraProvider } from './verra.provider';
import * as verraAdapter from '../../../../oracle/verra-adapter';

describe('VerraProvider', () => {
  let provider: VerraProvider;

  beforeEach(() => {
    provider = new VerraProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches measurement using verra-adapter and returns valid MeasurementData', async () => {
    const mockReport = {
      project_id: 'VCS-1234',
      provider: 'VerraRegistry',
      methodology: 'VERRA-VCS',
      period_start: '2025-01-01',
      period_end: '2025-03-31',
      carbon_sequestered: 50000,
      confidence: 0.95,
      ipfs_evidence_hash: 'QmRealHash12345678901234567890123456789012345',
      evidence: {},
    };

    jest.spyOn(verraAdapter, 'pollVerraProject').mockResolvedValue(mockReport as any);

    const result = await provider.fetchMeasurement('VCS-1234');

    expect(verraAdapter.pollVerraProject).toHaveBeenCalledWith(
      'VCS-1234',
      { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
      {},
    );
    expect(result.projectId).toBe('VCS-1234');
    expect(result.carbonSequesteredKg).toBe(50000);
    expect(result.confidence).toBe(0.95);
    expect(result.evidenceHashes).toEqual(['QmRealHash12345678901234567890123456789012345']);
  });

  it('fails closed when upstream is unreachable or returns error', async () => {
    jest.spyOn(verraAdapter, 'pollVerraProject').mockRejectedValue(new Error('Upstream unreachable'));

    await expect(provider.fetchMeasurement('VCS-1234')).rejects.toThrow('Upstream unreachable');
  });
});
