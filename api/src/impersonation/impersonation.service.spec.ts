import { Test, TestingModule } from '@nestjs/testing';
import { ImpersonationService } from './impersonation.service';
import { ImpersonationScope } from './impersonation.interface';

process.env.STELLAR_PUBLIC_KEY = 'GADMINKEY';

describe('ImpersonationService (#264)', () => {
  let service: ImpersonationService;
  const ADMIN = 'GADMINKEY';
  const NON_ADMIN = 'GRANDOMUSER';
  const TARGET = 'GAFFECTEDUSER';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ImpersonationService],
    }).compile();
    service = module.get<ImpersonationService>(ImpersonationService);
  });

  const scope = (extra: Partial<ImpersonationScope> = {}): ImpersonationScope => ({
    allowedOperations: ['bond.read', 'subscription.read'],
    ...extra,
  });

  const startSession = async (overrides: Record<string, any> = {}) =>
    service.start({
      maintainerAddress: ADMIN,
      targetAddress: TARGET,
      scope: scope(),
      reason: 'support ticket #123',
      ...overrides,
    });

  describe('allowed sessions', () => {
    it('starts a session scoped to an explicit operation list', async () => {
      const session = await startSession();

      expect(session.targetAddress).toBe(TARGET);
      expect(session.maintainerAddress).toBe(ADMIN);
      expect(session.scope.allowedOperations).toEqual(['bond.read', 'subscription.read']);
      expect(session.reason).toBe('support ticket #123');
    });

    it('permits an operation inside the scope', async () => {
      const session = await startSession();

      const decision = await service.performOperation(session.sessionId, 'bond.read');

      expect(decision.allowed).toBe(true);
      expect(decision.denialReason).toBeUndefined();
    });

    it('denies an operation outside the scope, even a harmless one', async () => {
      const session = await startSession();

      const decision = await service.performOperation(session.sessionId, 'bond.transfer_ownership');

      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe('operation_not_in_scope');
      expect(decision.reason).toContain('not in the session scope');
    });

    it('blocks dangerous mutations unless explicitly granted', async () => {
      const session = await startSession({ scope: scope({ allowedOperations: ['bond.migrate'], allowDangerousMutations: false }) });

      const denied = await service.performOperation(session.sessionId, 'bond.migrate', { dangerous: true });
      expect(denied.allowed).toBe(false);
      expect(denied.denialReason).toBe('dangerous_mutation_blocked');

      service.clear();
      const granted = await startSession({ scope: scope({ allowedOperations: ['bond.migrate'], allowDangerousMutations: true }) });
      const allowed = await service.performOperation(granted.sessionId, 'bond.migrate', { dangerous: true });
      expect(allowed.allowed).toBe(true);
    });
  });

  describe('denied sessions', () => {
    it('refuses to start a session for a non-admin principal', async () => {
      await expect(
        service.start({ maintainerAddress: NON_ADMIN, targetAddress: TARGET, scope: scope(), reason: 'nope' }),
      ).rejects.toThrow('Admin access required');
    });

    it('refuses a session with no reason', async () => {
      await expect(
        service.start({ maintainerAddress: ADMIN, targetAddress: TARGET, scope: scope(), reason: '   ' }),
      ).rejects.toThrow('reason is required');
    });

    it('refuses to start without an explicit operation list', async () => {
      await expect(
        service.start({ maintainerAddress: ADMIN, targetAddress: TARGET, scope: { allowedOperations: undefined as any }, reason: 'x' }),
      ).rejects.toThrow('allowedOperations list is required');
    });

    it('denies an operation under an unknown session id', async () => {
      const decision = await service.performOperation('no-such-session', 'bond.read');

      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe('no_active_session');
    });

    it('denies an operation on a session the maintainer already ended', async () => {
      const session = await startSession();
      await service.end(session.sessionId, ADMIN);

      const decision = await service.performOperation(session.sessionId, 'bond.read');

      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe('revoked');
    });

    it('only the owning maintainer can end a session', async () => {
      const session = await startSession();

      expect(await service.end(session.sessionId, NON_ADMIN)).toBe(false);

      const decision = await service.performOperation(session.sessionId, 'bond.read');
      expect(decision.allowed).toBe(true); // untouched
    });
  });

  describe('expired sessions', () => {
    it('enforces expiry and refuses to act afterwards', async () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const session = await startSession({ ttlSeconds: 60, now: start });

      const inside = await service.performOperation(session.sessionId, 'bond.read', { now: new Date(start.getTime() + 59_000) });
      expect(inside.allowed).toBe(true);

      const after = await service.performOperation(session.sessionId, 'bond.read', { now: new Date(start.getTime() + 61_000) });
      expect(after.allowed).toBe(false);
      expect(after.denialReason).toBe('expired');
    });

    it('clamps an excessive TTL to the maximum and never extends a session', async () => {
      const session = await startSession({ ttlSeconds: 60 * 60 * 24 });

      const maxTtlMs = new Date(session.expiresAt).getTime() - new Date(session.startedAt).getTime();
      expect(maxTtlMs).toBeLessThanOrEqual(30 * 60 * 1000);
    });

    it('reports an expired session as expired on the next operation attempt', async () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const session = await startSession({ ttlSeconds: 60, now: start });

      // A 60s session evaluated against a clock 2 minutes later is expired,
      // even though no operation was ever performed inside the window.
      const decision = await service.performOperation(
        session.sessionId,
        'bond.read',
        { now: new Date(start.getTime() + 120_000) },
      );

      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe('expired');
      expect(session.endedAt).toBeDefined();
      expect(session.endReason).toBe('expired');
    });
  });

  describe('audit trail', () => {
    it('records start, allowed operation, denied operation, and end', async () => {
      const session = await startSession();

      await service.performOperation(session.sessionId, 'bond.read');
      await service.performOperation(session.sessionId, 'bond.transfer_ownership');
      await service.end(session.sessionId, ADMIN);

      const trail = service.getAuditTrail();
      const events = trail.filter((e) => e.sessionId === session.sessionId).map((e) => e.event);

      expect(events).toEqual(['started', 'operation_allowed', 'operation_denied', 'ended']);
    });

    it('records the maintainer and target on every event, never just the session id', async () => {
      const session = await startSession();
      await service.performOperation(session.sessionId, 'bond.read');

      const [startEvent, opEvent] = service.getAuditTrail();

      expect(startEvent.event).toBe('started');
      expect(startEvent.maintainerAddress).toBe(ADMIN);
      expect(startEvent.targetAddress).toBe(TARGET);
      expect(opEvent.operation).toBe('bond.read');
      expect(opEvent.maintainerAddress).toBe(ADMIN);
    });

    it('records a denied dangerous mutation as its own event', async () => {
      const session = await startSession({ scope: scope({ allowedOperations: ['bond.migrate'] }) });

      await service.performOperation(session.sessionId, 'bond.migrate', { dangerous: true });

      const denial = service.getAuditTrail().find((e) => e.event === 'operation_denied');
      expect(denial).toBeDefined();
      expect(denial.operation).toBe('bond.migrate');
      expect(denial.detail).toContain('dangerous');
    });

    it('records an expired session as expired, not silently dropped', async () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const session = await startSession({ ttlSeconds: 10, now: start });

      await service.performOperation(session.sessionId, 'bond.read', { now: new Date(start.getTime() + 20_000) });

      const expired = service.getAuditTrail().find((e) => e.event === 'expired');
      expect(expired).toBeDefined();
      expect(expired.sessionId).toBe(session.sessionId);
    });
  });

  describe('visible indicators', () => {
    it('lists active sessions for a target user and excludes ended ones', async () => {
      // Real clock: sessions are long-lived relative to test execution.
      const active = await startSession({ ttlSeconds: 300 });
      const second = await startSession({ ttlSeconds: 300 });

      expect(service.getSessionsForTarget(TARGET)).toHaveLength(2);
      expect(service.getSessionsForTarget(TARGET).map((s) => s.sessionId).sort())
        .toEqual([active.sessionId, second.sessionId].sort());

      await service.end(second.sessionId, ADMIN);

      const remaining = service.getSessionsForTarget(TARGET);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe(active.sessionId);
    });

    it('surfaces nothing for a target with no sessions', () => {
      expect(service.getSessionsForTarget('GNOSUCHUSER')).toHaveLength(0);
    });
  });
});
