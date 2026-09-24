import { ProjectsService } from './projects.service';
import { decodeCid } from '../common/utils';

function memoryRedis() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

const digest = (n: number) => new Uint8Array(32).fill(n);

function serviceWith(redis: any, periodInfo: any[], report: any[]) {
  const svc = new ProjectsService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  (svc as any).redis = redis;
  (svc as any).contractService = {
    simulateCall: jest.fn(async ({ method }: any) =>
      method === 'get_period_info' ? periodInfo : report,
    ),
  };
  (svc as any).configService = {
    getCouponEngineAddress: () => 'CE',
    getOracleConsumerAddress: () => 'OC',
  };
  return svc;
}

describe('ProjectsService certification versioning (#213)', () => {
  it('appends immutable versions with a previous-CID chain and never rewrites history', async () => {
    const redis = memoryRedis();
    const svc = serviceWith(redis, [], []);
    const v1 = await svc.addCertification(1, 'QmV1', 'third-party-certification');
    const v2 = await svc.addCertification(1, 'QmV2', 'third-party-certification');
    const v3 = await svc.addCertification(1, 'QmV3', 'performance-report');
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect([v1.previousCid, v2.previousCid, v3.previousCid]).toEqual([null, 'QmV1', 'QmV2']);
    const history = await svc.getCertificationHistory(1);
    expect(history.map((v) => v.cid)).toEqual(['QmV1', 'QmV2', 'QmV3']);
    expect(history[0]).toEqual(v1);
  });

  it('rejects recording the same CID twice', async () => {
    const redis = memoryRedis();
    const svc = serviceWith(redis, [], []);
    await svc.addCertification(1, 'QmV1', 'document');
    await expect(svc.addCertification(1, 'QmV1', 'document')).rejects.toThrow();
    expect(await svc.getCertificationHistory(1)).toHaveLength(1);
  });

  it('resolves the exact CID that justified a coupon and keeps it stable across supersedes', async () => {
    const cidV1 = decodeCid(digest(1));
    const cidV2 = decodeCid(digest(2));
    const cidV3 = decodeCid(digest(3));
    // PeriodInfo tuple: [period_index, start, end, earned, distributed, report_id, undistributed]
    const periodInfo: any[] = [0, 1000, 2000, 100, true, 7, 0];
    // Report tuple with the evidence digest at index 8 (Report.ipfs_evidence_hash).
    const report: any[] = [7, 'provider', 'project', 1000, 2000, 100, null, 'meth', digest(1), 'Verified', 0, 0, 0];
    const redis = memoryRedis();
    const svc = serviceWith(redis, periodInfo, report);

    await svc.addCertification(1, cidV1, 'third-party-certification');
    const first = await svc.getCouponCertification(1, 9, 0);
    expect(first.reportId).toBe(7);
    expect(first.certificationCid).toBe(cidV1);
    expect(first.certificationVersion).toBe(1);
    const callsAfterFirst = (svc as any).contractService.simulateCall.mock.calls.length;

    // The certification is superseded twice afterwards...
    await svc.addCertification(1, cidV2, 'third-party-certification');
    await svc.addCertification(1, cidV3, 'performance-report');

    // ...but the historical provenance query still returns the original CID
    // from the immutable snapshot without re-querying the chain.
    const second = await svc.getCouponCertification(1, 9, 0);
    expect(second).toEqual(first);
    expect((svc as any).contractService.simulateCall.mock.calls.length).toBe(callsAfterFirst);
    expect(await svc.getCertificationHistory(1)).toHaveLength(3);
  });
});
