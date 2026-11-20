import { HolderIndexService } from './holder-index.service';
import { ContractService } from '../stellar/contract.service';
import { RedisService } from '../common/services/redis.service';
import { ConfigService } from '../config/config.service';
import { ConflictException } from '@nestjs/common';
import { nativeToScVal, scValToNative, Keypair } from '@stellar/stellar-sdk';

// Force the in-memory durable store regardless of the test environment.
process.env.NODE_ENV = 'test';
process.env.HOLDER_INDEX_STORE = 'memory';

const A = 'GBLG33K2H6RZKCKNRPA5VEITPHOAEDYL7HN6WS3OYFOL5UAXO5QWHLMI';
const B = 'GBL5ZNRGB26PBXWIFAKVYZCEI7FRW3RRYZB3MAMJOX77WBCJTLJIVKOB';

function makeService(redis: any, contract: any) {
  const config = { getBondIssuerAddress: jest.fn().mockReturnValue('BOND') };
  return new HolderIndexService(contract, redis, config as unknown as ConfigService);
}

describe('HolderIndexService', () => {
  const balanceMap = new Map<string, bigint>();

  const contract = {
    simulateCall: jest.fn(({ args }) => {
      // args[1] is the holder address ScVal
      const address = scValToNative(args[1]) as string;
      const bal = balanceMap.get(address) ?? 0n;
      return Promise.resolve(nativeToScVal(bal, { type: 'i128' }));
    }),
  };

  beforeEach(() => {
    balanceMap.clear();
  });

  it('records a subscribe as an authoritative holder independent of Redis', async () => {
    const redis = { sAdd: jest.fn().mockResolvedValue(undefined) };
    const service = makeService(redis, contract);

    await service.recordSubscribe(1, A);

    expect(await service.getAuthoritativeHolders(1)).toContain(A);
    // Redis was used as a cache, not the source of truth.
    expect(redis.sAdd).toHaveBeenCalledWith('bond:1:holders', A);
  });

  it('survives Redis loss: holders persist without Redis', async () => {
    const redis = { sAdd: jest.fn().mockRejectedValue(new Error('Redis down')) };
    const service = makeService(redis, contract);

    await service.recordSubscribe(1, A);

    // Even though sAdd failed, the durable index retains the holder.
    expect(await service.getAuthoritativeHolders(1)).toEqual([A]);
  });

  it('returns holder balances and prunes zero-balance holders', async () => {
    const service = makeService({ sAdd: jest.fn().mockResolvedValue(undefined) }, contract);
    balanceMap.set(A, 100n);
    balanceMap.set(B, 0n);

    await service.recordSubscribe(1, A);
    await service.recordSubscribe(1, B);

    const holders = await service.getHoldersWithBalances(1);
    expect(holders).toEqual([{ address: A, balance: '100' }]);
    expect(await service.getAuthoritativeHolders(1)).toEqual([A]);
  });

  it('discovers out-of-band transfers via reconciliation', async () => {
    const service = makeService({ sAdd: jest.fn().mockResolvedValue(undefined) }, contract);
    // A was known through the API, but a direct contract transfer moved A's
    // balance to B (which the API never recorded).
    balanceMap.set(A, 0n);
    balanceMap.set(B, 250n);

    await service.recordSubscribe(1, A);
    const reconciled = await service.reconcileBond(1, [B]);

    const addresses = reconciled.map((h) => h.address).sort();
    expect(addresses).toEqual([B]);
    expect(await service.getAuthoritativeHolders(1)).toEqual([B]);
  });

  it('refuses coupon distribution on an unseeded, empty index (strict)', async () => {
    const service = makeService({ sAdd: jest.fn().mockResolvedValue(undefined) }, contract);
    await expect(service.getHoldersForCoupon(1, { requireFresh: true })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('returns reconciled holders for coupon distribution after seeding', async () => {
    const service = makeService({ sAdd: jest.fn().mockResolvedValue(undefined) }, contract);
    balanceMap.set(A, 50n);

    await service.recordSubscribe(1, A);
    const holders = await service.getHoldersForCoupon(1, { requireFresh: true });
    expect(holders).toEqual([A]);
  });
});
