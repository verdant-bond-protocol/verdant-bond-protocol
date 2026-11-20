import { UnauthorizedException } from '@nestjs/common';
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
  const jwt = {
    sign: jest.fn(() => 'token'),
    verify: jest.fn(),
  };
  const sessions = {
    issue: jest.fn(async () => ({ sessionVersion: 3, jti: 'session-1' })),
    currentVersion: jest.fn(async () => 3),
    assertActive: jest.fn(async () => undefined),
  };
  const authService = new AuthService(
    jwt as never,
    { getStatus: jest.fn(async () => 'pending') } as never,
    stellarService as never,
    redis as never,
    {
      getJwtExpiry: () => '15m',
      getJwtRefreshExpiry: () => '7d',
      getJwtRefreshSecret: () => 'refresh-secret',
    } as never,
    new RbacService(),
    sessions as never,
  );

  beforeEach(() => {
    process.env.STELLAR_AUTH_SECRET_KEY = serverKeypair.secret();
    jest.clearAllMocks();
  });

  afterAll(() => {
    delete process.env.STELLAR_AUTH_SECRET_KEY;
  });

  async function signedChallenge() {
    const challenge = await authService.generateChallenge(userKeypair.publicKey());
    const transaction = TransactionBuilder.fromXDR(
      challenge.challenge,
      stellarService.getNetworkPassphrase(),
    );
    transaction.sign(userKeypair);
    return {
      address: userKeypair.publicKey(),
      originalChallenge: challenge.challenge,
      signedChallenge: transaction.toXDR(),
    };
  }

  it('verifies a SEP-10-style signed transaction envelope', async () => {
    await expect(authService.verifySignature(await signedChallenge()))
      .resolves.toMatchObject({ tokenType: 'Bearer' });
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

  it('stamps access and refresh tokens with the session version and id', async () => {
    await authService.verifySignature(await signedChallenge());
    expect(sessions.issue).toHaveBeenCalledWith(userKeypair.publicKey());
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({
      sub: userKeypair.publicKey(), sv: 3, jti: 'session-1',
    }));
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({
      tokenType: 'refresh', sv: 3, jti: 'session-1',
    }), expect.anything());
  });

  it('refuses to refresh a stale or revoked session', async () => {
    jwt.verify.mockReturnValueOnce({
      sub: userKeypair.publicKey(), kycStatus: 'pending', tokenType: 'refresh', sv: 1, jti: 'old-session',
    });
    sessions.assertActive.mockRejectedValueOnce(new UnauthorizedException('Session is stale'));

    await expect(authService.refreshToken('refresh-token')).rejects.toThrow('Invalid or expired token');
    expect(sessions.assertActive).toHaveBeenCalledWith({
      sub: userKeypair.publicKey(), sv: 1, jti: 'old-session',
    });
    expect(jwt.sign).not.toHaveBeenCalled();
  });
});
