import { IotProvider } from './iot.provider';
import * as iotAggregator from '../../../../oracle/iot-aggregator';

describe('IotProvider', () => {
  let provider: IotProvider;

  beforeEach(() => {
    provider = new IotProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches measurement using iot-aggregator and returns valid MeasurementData', async () => {
    const mockReport = {
      project_id: 'VCS-1234',
      provider: 'IotSensorNetwork',
      methodology: 'IOT-SENSORS',
      period_start: '2025-01-01',
      period_end: '2025-03-31',
      carbon_sequestered: 35000,
      confidence: 0.75,
      ipfs_evidence_hash: 'QmIotRealHash123456789012345678901234567890',
      evidence: {},
    };

    jest.spyOn(iotAggregator, 'aggregateIotProject').mockResolvedValue(mockReport as any);

    const result = await provider.fetchMeasurement('VCS-1234');

    expect(iotAggregator.aggregateIotProject).toHaveBeenCalledWith(
      {
        project_id: 'VCS-1234',
        device_ids: ['NBS-SOIL-001', 'NBS-SOIL-002'],
        area_ha: 1250,
      },
      { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
      {},
    );
    expect(result.projectId).toBe('VCS-1234');
    expect(result.carbonSequesteredKg).toBe(35000);
    expect(result.confidence).toBe(0.75);
    expect(result.evidenceHashes).toEqual(['QmIotRealHash123456789012345678901234567890']);
  });

  it('fails closed when IoT endpoint fails', async () => {
    jest
      .spyOn(iotAggregator, 'aggregateIotProject')
      .mockRejectedValue(new Error('IoT API Connection Refused'));

    await expect(provider.fetchMeasurement('VCS-1234')).rejects.toThrow(
      'IoT API Connection Refused',
    );
  });
});
