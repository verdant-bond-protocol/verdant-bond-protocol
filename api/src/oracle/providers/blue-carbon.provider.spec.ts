import { BlueCarbonProvider } from './blue-carbon.provider';
import * as blueCarbonAdapter from '../../../../oracle/blue-carbon-adapter';

describe('BlueCarbonProvider', () => {
  let provider: BlueCarbonProvider;

  beforeEach(() => {
    provider = new BlueCarbonProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches measurement using blue-carbon-adapter and returns valid MeasurementData', async () => {
    const mockReport = {
      project_id: 'BLUE-2024-001',
      provider: 'BlueCarbonObservatory',
      methodology: 'BLUE-CARBON',
      period_start: '2025-01-01',
      period_end: '2025-03-31',
      carbon_sequestered: 86000,
      confidence: 0.8,
      ipfs_evidence_hash: 'QmBlueRealHash1234567890123456789012345678',
      evidence: {},
    };

    jest.spyOn(blueCarbonAdapter, 'aggregateBlueCarbonProject').mockResolvedValue(mockReport as any);

    const result = await provider.fetchMeasurement('BLUE-2024-001');

    expect(blueCarbonAdapter.aggregateBlueCarbonProject).toHaveBeenCalledWith(
      {
        project_id: 'BLUE-2024-001',
        habitat: 'mangrove',
        area_ha: 500,
        baseline_carbon_t_per_ha: 480,
        root_shoot_ratio: 0.8,
      },
      { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
      {},
    );
    expect(result.projectId).toBe('BLUE-2024-001');
    expect(result.carbonSequesteredKg).toBe(86000);
    expect(result.confidence).toBe(0.8);
    expect(result.evidenceHashes).toEqual(['QmBlueRealHash1234567890123456789012345678']);
  });

  it('fails closed when blue carbon endpoint fails', async () => {
    jest
      .spyOn(blueCarbonAdapter, 'aggregateBlueCarbonProject')
      .mockRejectedValue(new Error('Blue Carbon API Network Error'));

    await expect(provider.fetchMeasurement('BLUE-2024-001')).rejects.toThrow(
      'Blue Carbon API Network Error',
    );
  });
});
