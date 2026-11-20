import { IntentService } from './intent.service';
import { RedisService } from './redis.service';
import { Keypair } from '@stellar/stellar-sdk';
import { UnauthorizedException, ConflictException } from '@nestjs/common';

function makeIntent(
  kp: Keypair,
  action: string,
  target: string,
  chain = 'testnet',
  expiryOffsetMs = 60_000,
  nonce = 'n',
): any {
  const expiry = Date.now() + expiryOffsetMs;
  const message = Buffer.from(`${action}|${target}|${chain}|${expiry}|${nonce}`, 'utf8');
  return {
    action,
    target,
    chain,
    expiry,
    nonce,
    signature: kp.sign(message).toString('base64'),
  };
}

describe('IntentService', () => {
  let service: IntentService;
  let kp: Keypair;
  let redis: any;

  beforeEach(() => {
    kp = Keypair.random();
    process.env.STELLAR_PUBLIC_KEY = kp.publicKey();
    redis = { setNx: jest.fn().mockResolvedValue(true) };
    service = new IntentService(redis as unknown as RedisService);
  });

  it('accepts a valid intent and consumes its nonce', async () => {
    const intent = makeIntent(kp, 'issue_bond', 'global', 'testnet', 60_000, 'n1');
    const result = await service.verify(intent, 'issue_bond', 'global');
    expect(result.nonce).toBe('n1');
    expect(redis.setNx).toHaveBeenCalledWith('admin-intent:n1', expect.any(Number));
  });

  it('rejects a missing intent', async () => {
    await expect(service.verify(undefined, 'issue_bond', 'global')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired intent', async () => {
    const intent = makeIntent(kp, 'issue_bond', 'global', 'testnet', -1000, 'n2');
    await expect(service.verify(intent, 'issue_bond', 'global')).rejects.toThrow(/expired/i);
  });

  it('rejects a wrong-action intent', async () => {
    const intent = makeIntent(kp, 'other_action', 'global', 'testnet', 60_000, 'n3');
    await expect(service.verify(intent, 'issue_bond', 'global')).rejects.toThrow(/action mismatch/i);
  });

  it('rejects a wrong-target intent', async () => {
    const intent = makeIntent(kp, 'issue_bond', '999', 'testnet', 60_000, 'n4');
    await expect(service.verify(intent, 'issue_bond', 'global')).rejects.toThrow(/target mismatch/i);
  });

  it('rejects an invalid signature', async () => {
    const intent = makeIntent(kp, 'issue_bond', 'global', 'testnet', 60_000, 'n5');
    intent.signature = 'AAAAinvalid';
    await expect(service.verify(intent, 'issue_bond', 'global')).rejects.toThrow(/signature/i);
  });

  it('rejects replay (nonce reuse) deterministically', async () => {
    const intent = makeIntent(kp, 'issue_bond', 'global', 'testnet', 60_000, 'n6');
    redis.setNx.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await service.verify(intent, 'issue_bond', 'global');
    await expect(service.verify(intent, 'issue_bond', 'global')).rejects.toBeInstanceOf(ConflictException);
  });
});
