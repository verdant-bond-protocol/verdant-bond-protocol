import { ContractService } from './contract.service';
import { StellarService } from './stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { ConfigService } from '../config/config.service';

describe('ContractService Soroban polling', () => {
  const service = new ContractService(
    {} as StellarService,
    {} as NonceService,
    {} as ConfigService,
  );

  beforeEach(() => {
    process.env.SOROBAN_POLL_INTERVAL_MS = '1';
    process.env.SOROBAN_POLL_TIMEOUT_MS = '2000';
  });

  afterEach(() => {
    delete process.env.SOROBAN_POLL_INTERVAL_MS;
    delete process.env.SOROBAN_POLL_TIMEOUT_MS;
  });

  it('retries not found and pending responses until success', async () => {
    const rpc = service.getSorobanRpc() as any;
    rpc.getTransaction = jest.fn()
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'PENDING' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    await expect((service as any).pollTransaction('hash')).resolves.toEqual({ status: 'SUCCESS' });
    expect(rpc.getTransaction).toHaveBeenCalledTimes(3);
  });

  it('returns terminal failed responses for useful error mapping', async () => {
    const rpc = service.getSorobanRpc() as any;
    rpc.getTransaction = jest.fn().mockResolvedValue({
      status: 'FAILED',
      errorResult: 'contract error #7',
    });

    const result = await (service as any).pollTransaction('hash');
    expect(result.status).toBe('FAILED');
    expect((service as any).describeTransactionFailure(result)).toContain('contract error #7');
  });
});
