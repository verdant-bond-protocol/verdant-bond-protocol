import {
  assessMultiOracleFeed,
  MultiOracleMonitor,
  OracleSourceReading,
} from './multi-oracle-monitor';

describe('Multi-oracle freshness and outlier monitoring (#617)', () => {
  const NOW = Date.parse('2026-10-01T00:00:00.000Z');
  const FRESH_TS = new Date(NOW - 3600 * 1000).toISOString(); // 1h ago
  const VERY_STALE_TS = new Date(NOW - 70 * 24 * 3600 * 1000).toISOString();

  const makeReading = (
    sourceId: string,
    carbon: number,
    observedAt = FRESH_TS,
  ): OracleSourceReading => ({
    sourceId,
    projectId: 'PROJ-1',
    periodKey: '2026-Q3',
    methodology: 'IOT-SENSORS',
    carbon,
    observedAt,
  });

  it('returns healthy consensus when fresh authorized sources agree within tolerance', () => {
    const readings = [
      makeReading('iot-a', 100),
      makeReading('iot-b', 105),
      makeReading('iot-c', 98),
    ];

    const result = assessMultiOracleFeed('PROJ-1', '2026-Q3', readings, {
      minQuorum: 2,
      authorizedSources: ['iot-a', 'iot-b', 'iot-c'],
      nowMs: NOW,
    });

    expect(result.status).toBe('healthy');
    expect(result.quorumMet).toBe(true);
    expect(result.consensusCarbon).toBe(100);
    expect(result.freshSources).toEqual(['iot-a', 'iot-b', 'iot-c']);
    expect(result.staleSources).toEqual([]);
    expect(result.outlierSources).toEqual([]);
  });

  it('excludes stale sources and marks degraded when quorum still holds', () => {
    const readings = [
      makeReading('iot-a', 100, FRESH_TS),
      makeReading('iot-b', 104, FRESH_TS),
      makeReading('iot-c', 99, VERY_STALE_TS),
    ];

    const result = assessMultiOracleFeed('PROJ-1', '2026-Q3', readings, {
      minQuorum: 2,
      nowMs: NOW,
    });

    expect(result.status).toBe('degraded');
    expect(result.quorumMet).toBe(true);
    expect(result.staleSources).toEqual(['iot-c']);
    expect(result.consensusCarbon).toBe(102);
  });

  it('marks critical when stale sources drop fresh count below quorum', () => {
    const readings = [
      makeReading('iot-a', 100, FRESH_TS),
      makeReading('iot-b', 102, VERY_STALE_TS),
      makeReading('iot-c', 99, VERY_STALE_TS),
    ];

    const result = assessMultiOracleFeed('PROJ-1', '2026-Q3', readings, {
      minQuorum: 2,
      nowMs: NOW,
    });

    expect(result.status).toBe('critical');
    expect(result.quorumMet).toBe(false);
    expect(result.consensusCarbon).toBeNull();
    expect(result.staleSources).toEqual(['iot-b', 'iot-c']);
  });

  it('excludes statistical outlier from consensus when remaining inliers meet quorum', () => {
    const readings = [
      makeReading('iot-a', 100),
      makeReading('iot-b', 104),
      makeReading('iot-c', 500), // outlier
    ];

    const result = assessMultiOracleFeed('PROJ-1', '2026-Q3', readings, {
      minQuorum: 2,
      nowMs: NOW,
    });

    expect(result.status).toBe('degraded');
    expect(result.quorumMet).toBe(true);
    expect(result.outlierSources).toEqual(['iot-c']);
    expect(result.consensusCarbon).toBe(102);
  });

  it('rejects unauthorized sources and invalid negative/NaN readings', () => {
    const readings = [
      makeReading('iot-a', 100),
      makeReading('iot-b', 102),
      makeReading('rogue-node', 9999),
      makeReading('iot-bad', -50),
    ];

    const result = assessMultiOracleFeed('PROJ-1', '2026-Q3', readings, {
      minQuorum: 2,
      authorizedSources: ['iot-a', 'iot-b', 'iot-bad'],
      nowMs: NOW,
    });

    expect(result.unauthorizedSources).toEqual(['rogue-node']);
    expect(result.rejectedReadings.some((r) => r.reason === 'invalid_reading')).toBe(true);
    expect(result.quorumMet).toBe(true);
    expect(result.consensusCarbon).toBe(101);
  });

  it('retries transient feed failures and tracks source recovery', async () => {
    const monitor = new MultiOracleMonitor({
      minQuorum: 2,
      authorizedSources: ['iot-a', 'iot-b'],
      nowMs: NOW,
    });

    const { assessment, attempts } = await monitor.assessWithRetry(
      'PROJ-1',
      '2026-Q3',
      async (attempt) => {
        if (attempt === 0) {
          return [
            makeReading('iot-a', 100, FRESH_TS),
            makeReading('iot-b', 102, VERY_STALE_TS),
          ];
        }
        return [
          makeReading('iot-a', 100, FRESH_TS),
          makeReading('iot-b', 102, FRESH_TS),
        ];
      },
      2,
    );

    expect(attempts).toBe(2);
    expect(assessment.status).toBe('healthy');
    expect(assessment.quorumMet).toBe(true);
    expect(monitor.getFailureCount('iot-b')).toBe(0);
  });
});
