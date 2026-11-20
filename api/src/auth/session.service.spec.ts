import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SessionService } from './session.service';
import { canRevokeSessions } from './session-revocation.interface';
import { JwtStrategy } from './jwt.strategy';

describe('Session revocation & stale sessions', () => {
  const USER = 'GUSERADDRESS';
  const OTHER = 'GOTHERADDRESS';
  let store: Map<string, string>;
  let failing: boolean;
  let service: SessionService;

  const redis = {
    getOrThrow: jest.fn(async (key: string) => {
      if (failing) throw new Error('redis down');
      return store.get(key) ?? null;
    }),
    incrOrThrow: jest.fn(async (key: string) => {
      if (failing) throw new Error('redis down');
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: jest.fn(async () => true),
    set: jest.fn(async (key: string, value: string) => {
      if (failing) return null;
      store.set(key, value);
      return 'OK';
    }),
  };

  beforeEach(() => {
    store = new Map();
    failing = false;
    service = new SessionService(redis as never);
    service.setFailOpen(false);
    jest.clearAllMocks();
  });

  describe('normal paths', () => {
    it('issues a session id pinned to the current epoch and validates it', async () => {
      const { sessionVersion, jti } = await service.issue(USER);
      expect(sessionVersion).toBe(0);
      expect(jti).toEqual(expect.any(String));
      await expect(service.assertActive({ sub: USER, sv: sessionVersion, jti })).resolves.toBeUndefined();
    });

    it('accepts a legacy token without sv/jti while the epoch is 0', async () => {
      await expect(service.assertActive({ sub: USER })).resolves.toBeUndefined();
    });

    it('revoking one session does not touch a sibling session', async () => {
      const a = await service.issue(USER);
      const b = await service.issue(USER);
      await service.revokeToken(a.jti);
      await expect(service.assertActive({ sub: USER, ...a })).rejects.toThrow('revoked');
      await expect(service.assertActive({ sub: USER, ...b })).resolves.toBeUndefined();
    });
  });

  describe('failure paths', () => {
    it('revokeAll invalidates every token minted at an older epoch', async () => {
      const old = await service.issue(USER);
      const version = await service.revokeAll(USER, { walletAddress: USER }, 'suspicious activity');
      expect(version).toBe(1);
      await expect(service.assertActive({ sub: USER, ...old })).rejects.toThrow('stale');
      const fresh = await service.issue(USER);
      expect(fresh.sessionVersion).toBe(1);
      await expect(service.assertActive({ sub: USER, sv: fresh.sessionVersion, jti: fresh.jti }))
        .resolves.toBeUndefined();
    });

    it('also invalidates a legacy token on the first revokeAll', async () => {
      await service.revokeAll(USER, { walletAddress: USER });
      await expect(service.assertActive({ sub: USER })).rejects.toThrow('stale');
    });

    it('fails closed when revocation state cannot be read', async () => {
      failing = true;
      await expect(service.assertActive({ sub: USER })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('surfaces a failed revoke so the caller can retry', async () => {
      failing = true;
      await expect(service.revokeAll(USER, { walletAddress: USER })).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.revokeToken('jti-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('retry paths', () => {
    it('revokeToken is idempotent and a failed revoke succeeds after recovery', async () => {
      await service.revokeToken('jti-1');
      await service.revokeToken('jti-1'); // replay: same result
      expect(await service.isJtiRevoked('jti-1')).toBe(true);
      await expect(service.assertActive({ sub: USER, jti: 'jti-1' })).rejects.toThrow('revoked');

      failing = true;
      await expect(service.revokeToken('jti-2')).rejects.toBeInstanceOf(ServiceUnavailableException);
      failing = false;
      await service.revokeToken('jti-2');
      expect(await service.isJtiRevoked('jti-2')).toBe(true);
    });

    it('a retry after a Redis outage uses the in-process mirror', async () => {
      await service.revokeToken('jti-3');
      await service.revokeAll(USER, { walletAddress: USER });
      failing = true;
      // Redis is down, but the mirror still knows both revocations.
      expect(await service.isJtiRevoked('jti-3')).toBe(true);
      await expect(service.assertActive({ sub: USER, sv: 0, jti: 'jti-3' })).rejects.toThrow();
      await expect(service.assertActive({ sub: USER, sv: 1 })).resolves.toBeUndefined();
    });

    it('fail-open mode degrades to allowing the request (documented recovery lever)', async () => {
      service.setFailOpen(true);
      failing = true;
      await expect(service.assertActive({ sub: USER, sv: 0 })).resolves.toBeUndefined();
      await expect(service.revokeAll(USER, { walletAddress: USER })).resolves.toBe(1);
    });
  });

  describe('authorization paths', () => {
    it('allows self, admin and permission holders but not a stranger', () => {
      expect(canRevokeSessions({ walletAddress: USER }, USER)).toBe(true);
      expect(canRevokeSessions({ walletAddress: OTHER }, USER)).toBe(false);
      expect(canRevokeSessions({ walletAddress: OTHER, roles: ['admin'] }, USER)).toBe(true);
      expect(canRevokeSessions({ walletAddress: OTHER, roles: ['maintainer'] }, USER)).toBe(true);
      expect(canRevokeSessions({ walletAddress: OTHER, permissions: ['auth:sessions:revoke'] }, USER)).toBe(true);
      expect(canRevokeSessions({ walletAddress: OTHER, permissions: ['manage_incidents'] }, USER)).toBe(true);
      expect(canRevokeSessions({ walletAddress: '' }, USER)).toBe(false);
    });

    it('service enforces the rule even if a caller bypasses the controller', async () => {
      await expect(service.revokeAll(USER, { walletAddress: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.size).toBe(0); // no side effect on a forbidden attempt
      await expect(service.revokeAll(USER, { walletAddress: OTHER, roles: ['admin'] })).resolves.toBe(1);
    });
  });

  describe('JwtStrategy integration', () => {
    const strategy = (svc: SessionService) =>
      new JwtStrategy({ getJwtSecret: () => 'test-secret' } as never, svc);

    it('passes a current token through and exposes session claims', async () => {
      const { sessionVersion, jti } = await service.issue(USER);
      const user = await strategy(service).validate({
        sub: USER, kycStatus: 'verified', roles: [], permissions: [], sv: sessionVersion, jti,
      });
      expect(user).toMatchObject({
        walletAddress: USER, sessionId: jti, sessionVersion: 0,
      });
    });

    it('rejects a stale token on every guarded route', async () => {
      const old = await service.issue(USER);
      await service.revokeAll(USER, { walletAddress: USER });
      await expect(strategy(service).validate({
        sub: USER, kycStatus: 'verified', sv: old.sessionVersion, jti: old.jti,
      })).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
