import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { AuthService } from './auth.service';
import { RbacService } from './rbac.service';

describe('AuthService', () => {
  const userKeypair = Keypair.random();
  const serverKeypair = Keypair.random();
  const storedChallenges = new Map<string, string>();
  const redis = {
    set: jest.fn(async (key: string, value: string) => storedChallenges.set(key, value)),
    get: jest.fn(async (key: string) => storedChallenges.get(key)),
    del: jest.fn(async (key: string) => storedChallenges.delete(key)),
    getDel: jest.fn(async (key: string) => {
      const value = storedChallenges.get(key);
      storedChallenges.delete(key);
      return value;
    }),
  };
  const stellarService = {
    isValidPublicKey: (address: string) => Keypair.fromPublicKey(address).publicKey() === address,
    getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
  };
  const authService = new AuthService(
    { sign: jest.fn(() => 'token') } as never,
    { getStatus: jest.fn(async () => 'pending') } as never,
    stellarService as never,
    redis as never,
    {
      getJwtExpiry: () => '15m',
      getJwtRefreshExpiry: () => '7d',
      getJwtRefreshSecret: () => 'refresh-secret',
    } as never,
    new RbacService(),
  );

  beforeEach(() => {
    process.env.STELLAR_AUTH_SECRET_KEY = serverKeypair.secret();
  });

  afterAll(() => {
    delete process.env.STELLAR_AUTH_SECRET_KEY;
  });

  it('verifies a SEP-10-style signed transaction envelope', async () => {
    const challenge = await authService.generateChallenge(userKeypair.publicKey());
    const transaction = TransactionBuilder.fromXDR(
      challenge.challenge,
      stellarService.getNetworkPassphrase(),
    );
    transaction.sign(userKeypair);

    await expect(authService.verifySignature({
      address: userKeypair.publicKey(),
      originalChallenge: challenge.challenge,
      signedChallenge: transaction.toXDR(),
    })).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('rejects a raw signature over the challenge XDR', async () => {
    const challenge = await authService.generateChallenge(userKeypair.publicKey());
    const transaction = TransactionBuilder.fromXDR(
      challenge.challenge,
      stellarService.getNetworkPassphrase(),
    );
    const rawSignature = userKeypair.sign(transaction.hash()).toString('hex');

    await expect(authService.verifySignature({
      address: userKeypair.publicKey(),
      originalChallenge: challenge.challenge,
      signedChallenge: rawSignature,
    })).rejects.toThrow('Invalid signature');
  });
});