import { OracleScheduler } from './oracle.scheduler';
import { ReportStatus } from './interfaces/oracle.interface';

const providerAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function makeProvider(name = 'Verra', methodology = 'VERRA-VCS') {
  return {
    name,
    methodology,
    fetchMeasurement: jest.fn().mockResolvedValue({
      projectId: 'project-1',
      periodStart: new Date('2026-01-01T00:00:00.000Z'),
      periodEnd: new Date('2026-03-31T00:00:00.000Z'),
      carbonSequesteredKg: 1234.4,
      confidence: 0.91,
      evidenceHashes: ['ipfs://evidence'],
    }),
  };
}

describe('OracleScheduler', () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv };
    process.env.ORACLE_POLL_PROJECT_IDS = 'project-1';
    process.env.DEFAULT_PROVIDER_ADDRESS = providerAddress;
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  it('fetches provider measurements, validates them and submits reports', async () => {
    const oracleService = {
      submitReport: jest.fn().mockResolvedValue({
        id: 7,
        status: ReportStatus.Pending,
      }),
    };
    const monitoringService = { alertStaleProjects: jest.fn() };
    const verra = makeProvider('Verra', 'VERRA-VCS');
    const satellite = makeProvider('SatelliteProcessor', 'REMOTE-SENSING');
    const blueCarbon = makeProvider('BlueCarbonObservatory', 'BLUE-CARBON');
    const scheduler = new OracleScheduler(
      oracleService as any,
      monitoringService as any,
      verra as any,
      satellite as any,
      blueCarbon as any,
    );

    await scheduler.pollOracleData();

    expect(verra.fetchMeasurement).toHaveBeenCalledWith('project-1');
    expect(satellite.fetchMeasurement).toHaveBeenCalledWith('project-1');
    expect(blueCarbon.fetchMeasurement).toHaveBeenCalledWith('project-1');
    expect(oracleService.submitReport).toHaveBeenCalledTimes(3);
    expect(oracleService.submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        carbonSequestered: 1234,
        methodology: 'VERRA-VCS',
        evidenceHash: expect.any(String),
      }),
      providerAddress,
    );
  });

  it('uses provider-specific addresses from ORACLE_PROVIDER_ADDRESSES', async () => {
    process.env.ORACLE_PROVIDER_ADDRESSES = JSON.stringify({ Verra: providerAddress });
    delete process.env.DEFAULT_PROVIDER_ADDRESS;
    const oracleService = { submitReport: jest.fn().mockResolvedValue({ id: 1 }) };
    const scheduler = new OracleScheduler(
      oracleService as any,
      {} as any,
      makeProvider('Verra', 'VERRA-VCS') as any,
      makeProvider('SatelliteProcessor', 'REMOTE-SENSING') as any,
      makeProvider('BlueCarbonObservatory', 'BLUE-CARBON') as any,
    );

    await scheduler.pollOracleData();

    expect(oracleService.submitReport).toHaveBeenCalledTimes(1);
    expect(oracleService.submitReport).toHaveBeenCalledWith(expect.any(Object), providerAddress);
  });

  it('normalizes provider failures and continues polling remaining providers', async () => {
    const oracleService = { submitReport: jest.fn().mockResolvedValue({ id: 1 }) };
    const bad = makeProvider('Verra', 'VERRA-VCS');
    bad.fetchMeasurement.mockResolvedValue({ ...await bad.fetchMeasurement(), confidence: 2 });
    const good = makeProvider('SatelliteProcessor', 'REMOTE-SENSING');
    const scheduler = new OracleScheduler(
      oracleService as any,
      {} as any,
      bad as any,
      good as any,
      makeProvider('BlueCarbonObservatory', 'BLUE-CARBON') as any,
    );

    await scheduler.pollOracleData();

    expect(oracleService.submitReport).toHaveBeenCalledTimes(2);
  });

  it('skips polling when no project ids are configured', async () => {
    process.env.ORACLE_POLL_PROJECT_IDS = '';
    const oracleService = { submitReport: jest.fn() };
    const provider = makeProvider();
    const scheduler = new OracleScheduler(
      oracleService as any,
      {} as any,
      provider as any,
      makeProvider('SatelliteProcessor', 'REMOTE-SENSING') as any,
      makeProvider('BlueCarbonObservatory', 'BLUE-CARBON') as any,
    );

    await scheduler.pollOracleData();

    expect(provider.fetchMeasurement).not.toHaveBeenCalled();
    expect(oracleService.submitReport).not.toHaveBeenCalled();
  });
});
