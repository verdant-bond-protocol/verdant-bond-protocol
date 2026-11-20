import { UnauthorizedException, ForbiddenException, ExecutionContext } from '@nestjs/common';
import { KycGuard } from '../common/guards/kyc.guard';
import { ProviderGuard } from '../common/guards/provider.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';

function contextWithUser(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

interface KycServiceStub {
  isEligibleRecord: jest.Mock;
}

function makeKycGuard(status: KycStatus | 'missing'): { guard: KycGuard; kyc: KycServiceStub } {
  const kyc: KycServiceStub = {
    isEligibleRecord: jest.fn(),
  };
  if (status === 'missing') {
    kyc.isEligibleRecord.mockResolvedValue({ eligible: false, record: { status: KycStatus.NONE } });
  } else {
    kyc.isEligibleRecord.mockResolvedValue({
      eligible: status === KycStatus.VERIFIED,
      record: { status },
    });
  }
  return { guard: new KycGuard(kyc as any), kyc };
}

describe('KycGuard (role: verified)', () => {
  it('throws UnauthorizedException when there is no session user', async () => {
    const { guard } = makeKycGuard(KycStatus.NONE);
    await expect(guard.canActivate(contextWithUser(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a verified user and stamps the kyc status on the request', async () => {
    const { guard } = makeKycGuard(KycStatus.VERIFIED);
    const user: any = { walletAddress: 'G1', kycStatus: KycStatus.NONE };
    await expect(guard.canActivate(contextWithUser(user))).resolves.toBe(true);
    expect(user.kycStatus).toBe(KycStatus.VERIFIED);
  });

  it('rejects a pending user with a generic KYC message', async () => {
    const { guard } = makeKycGuard(KycStatus.PENDING);
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G1' }))).rejects.toThrow(
      /KYC verification required/,
    );
  });

  it('rejects an expired user with an expiry-specific message', async () => {
    const { guard } = makeKycGuard(KycStatus.EXPIRED);
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G1' }))).rejects.toThrow(
      /expired/,
    );
  });

  it('rejects a rejected user with a rejection-specific message', async () => {
    const { guard } = makeKycGuard(KycStatus.REJECTED);
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G1' }))).rejects.toThrow(
      /rejected/,
    );
  });

  it('rejects a missing/expired-adjacent status consistently with the service', async () => {
    const { guard, kyc } = makeKycGuard(KycStatus.ACCREDITED);
    kyc.isEligibleRecord.mockResolvedValue({ eligible: false, record: { status: KycStatus.ACCREDITED } });
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G1' }))).rejects.toThrow(
      /KYC verification required/,
    );
  });
});

describe('ProviderGuard (role: provider)', () => {
  const ORIGINAL = process.env.ORACLE_PROVIDER_WHITELIST;

  afterEach(() => {
    process.env.ORACLE_PROVIDER_WHITELIST = ORIGINAL;
  });

  it('throws UnauthorizedException when there is no session user', async () => {
    process.env.ORACLE_PROVIDER_WHITELIST = 'G_PROV';
    const guard = new ProviderGuard();
    await expect(guard.canActivate(contextWithUser(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a whitelisted provider', async () => {
    process.env.ORACLE_PROVIDER_WHITELIST = 'G_PROV1,G_PROV2';
    const guard = new ProviderGuard();
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G_PROV2' }))).resolves.toBe(true);
  });

  it('rejects a non-whitelisted wallet', async () => {
    process.env.ORACLE_PROVIDER_WHITELIST = 'G_PROV1';
    const guard = new ProviderGuard();
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G_OTHER' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AdminGuard (role: admin)', () => {
  const ORIGINAL = process.env.STELLAR_PUBLIC_KEY;

  afterEach(() => {
    process.env.STELLAR_PUBLIC_KEY = ORIGINAL;
  });

  it('throws when the admin key is not configured', async () => {
    delete process.env.STELLAR_PUBLIC_KEY;
    const guard = new AdminGuard();
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G1' }))).rejects.toThrow(
      /Admin key not configured/,
    );
  });

  it('allows the configured admin wallet', async () => {
    process.env.STELLAR_PUBLIC_KEY = 'G_ADMIN';
    const guard = new AdminGuard();
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G_ADMIN' }))).resolves.toBe(true);
  });

  it('rejects a non-admin wallet', async () => {
    process.env.STELLAR_PUBLIC_KEY = 'G_ADMIN';
    const guard = new AdminGuard();
    await expect(guard.canActivate(contextWithUser({ walletAddress: 'G_OTHER' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard();

  it('returns the user when authentication succeeded', () => {
    const user = { walletAddress: 'G1' };
    expect(guard.handleRequest(null, user, null)).toBe(user);
  });

  it('throws UnauthorizedException when there is no user', () => {
    expect(() => guard.handleRequest(null, null, null)).toThrow(UnauthorizedException);
  });

  it('rethrows the underlying error', () => {
    expect(() => guard.handleRequest(new Error('boom'), null, null)).toThrow(/boom/);
  });
});
