import { SatelliteProvider } from './satellite.provider';
import * as satelliteProcessor from '../../../../oracle/satellite-processor';

describe('SatelliteProvider', () => {
  let provider: SatelliteProvider;

  beforeEach(() => {
    provider = new SatelliteProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches measurement using satellite-processor and returns valid MeasurementData', async () => {
    const mockReport = {
      project_id: 'VCS-1234',
      provider: 'SatelliteProcessor',
      methodology: 'REMOTE-SENSING',
      period_start: '2025-01-01',
      period_end: '2025-03-31',
      carbon_sequestered: 42000,
      confidence: 0.85,
      ipfs_evidence_hash: 'QmSatRealHash123456789012345678901234567890',
      evidence: {},
    };

    jest.spyOn(satelliteProcessor, 'ingestSatelliteMeasurement').mockResolvedValue(mockReport as any);

    const result = await provider.fetchMeasurement('VCS-1234');

    expect(satelliteProcessor.ingestSatelliteMeasurement).toHaveBeenCalledWith(
      {
        project_id: 'VCS-1234',
        bbox: [-76.5, -6.2, -76.2, -5.9],
        area_ha: 1250,
        baseline_ndvi: 0.28,
      },
      { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
      {},
    );
    expect(result.projectId).toBe('VCS-1234');
    expect(result.carbonSequesteredKg).toBe(42000);
    expect(result.confidence).toBe(0.85);
    expect(result.evidenceHashes).toEqual(['QmSatRealHash123456789012345678901234567890']);
  });

  it('fails closed when satellite endpoint fails', async () => {
    jest
      .spyOn(satelliteProcessor, 'ingestSatelliteMeasurement')
      .mockRejectedValue(new Error('Satellite API 500 Internal Error'));

    await expect(provider.fetchMeasurement('VCS-1234')).rejects.toThrow(
      'Satellite API 500 Internal Error',
    );
  });
});
