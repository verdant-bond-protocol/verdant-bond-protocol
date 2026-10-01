import { createHash } from 'crypto';
import { IpfsService } from './ipfs.service';
import { IpfsUploadPolicy } from './ipfs-upload.policy';
import { IpfsHealthService } from './ipfs-health.service';

const okJson = (data: any) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => data,
  arrayBuffer: async () => new ArrayBuffer(0),
});
const failWith = (statusText: string) => () =>
  Promise.resolve({
    ok: false,
    status: 500,
    statusText,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
const serveBytes = (bytes: Buffer) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({}),
  arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

function serviceWithFetch(fetchFn: any): IpfsService {
  return new IpfsService(new IpfsUploadPolicy(), fetchFn);
}

describe('IpfsService redundant pinning (#211)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      IPFS_SECONDARY_API_URL: 'https://secondary.example',
      IPFS_SECONDARY_GATEWAY: 'https://secondary.example/ipfs/',
    };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('pinRedundant succeeds when the primary provider is down but the secondary is up', async () => {
    const fetchFn = jest.fn((url: string) =>
      String(url).startsWith('https://secondary.example')
        ? Promise.resolve(okJson({}))
        : failWith('primary down')(),
    );
    const result = await serviceWithFetch(fetchFn).pinRedundant('QmTest');
    expect(result.providers.find((p) => p.name === 'primary')?.ok).toBe(false);
    expect(result.providers.find((p) => p.name === 'secondary')?.ok).toBe(true);
  });

  it('pinRedundant throws only when every provider fails', async () => {
    const svc = serviceWithFetch(jest.fn(failWith('all down')));
    await expect(svc.pinRedundant('QmTest')).rejects.toThrow(/all providers/);
  });

  it('verifyPin reports per-provider retrievability and hash-match', async () => {
    const payload = Buffer.from('report-bytes');
    const digest = createHash('sha256').update(payload).digest('hex');
    const fetchFn = jest.fn((url: string) =>
      String(url).startsWith('https://secondary.example')
        ? Promise.resolve(serveBytes(payload))
        : Promise.reject(new Error('primary unreachable')),
    );
    const checks = await serviceWithFetch(fetchFn).verifyPin('QmTest', digest);
    expect(checks.find((c) => c.provider === 'primary')).toEqual({
      provider: 'primary',
      retrievable: false,
      hashMatches: null,
    });
    expect(checks.find((c) => c.provider === 'secondary')).toEqual({
      provider: 'secondary',
      retrievable: true,
      hashMatches: true,
    });
  });

  it('verifyPin flags tampered content via hash mismatch', async () => {
    const fetchFn = jest.fn(() =>
      Promise.resolve(serveBytes(Buffer.from('tampered'))),
    );
    const checks = await serviceWithFetch(fetchFn).verifyPin('QmTest', '0'.repeat(64));
    expect(checks.every((c) => c.hashMatches === false)).toBe(true);
  });
});

describe('IpfsHealthService escalation (#211)', () => {
  it('re-pins and continues when one provider fails verification', async () => {
    const payload = Buffer.from('ok');
    const digest = createHash('sha256').update(payload).digest('hex');
    const pinCalls: string[] = [];
    const fetchFn = jest.fn((url: string) => {
      if (String(url).includes('/pinning/')) {
        pinCalls.push(url);
        return Promise.resolve(okJson({}));
      }
      return String(url).startsWith('https://secondary.example')
        ? Promise.resolve(serveBytes(payload))
        : Promise.reject(new Error('primary down'));
    });
    const svc = serviceWithFetch(fetchFn);
    const redis = { get: jest.fn().mockResolvedValue('[]'), set: jest.fn() };
    const health = new IpfsHealthService(svc, redis as any);
    const checks = await health.verifyOne('QmTest', digest);
    expect(checks.find((c) => c.provider === 'primary')?.retrievable).toBe(false);
    // Escalation step 1 ran: an automatic re-pin was attempted.
    expect(pinCalls.length).toBeGreaterThan(0);
  });
});
