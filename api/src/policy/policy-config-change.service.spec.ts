import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from './policy.service';
import {
  POLICY_CONFIG_ENTITY_ID,
  POLICY_CONFIG_ENTITY_TYPE,
  PolicyConfigChangeService,
} from './policy-config-change.service';

const ADMIN = 'GADMINPRINCIPAL';

describe('PolicyConfigChangeService (#408)', () => {
  let audit: AuditService;
  let policy: PolicyService;
  let service: PolicyConfigChangeService;

  const history = () => audit.getEntityHistory(POLICY_CONFIG_ENTITY_TYPE, POLICY_CONFIG_ENTITY_ID);
  const change = (changeId: string, updates: Record<string, unknown>, reason = 'tighten limits') =>
    service.apply({ changeId, actor: ADMIN, reason, updates });

  beforeEach(() => {
    delete process.env.POLICY_CONFIG;
    audit = new AuditService();
    policy = new PolicyService({} as any);
    service = new PolicyConfigChangeService(policy, audit);
  });

  describe('normal path', () => {
    it('records evidence with actor, reason, change id, changed keys and before/after, then applies', async () => {
      const outcome = await change('chg-1', { maxSubscriptionAmount: '500000', restrictedJurisdictions: ['kp', 'IR', 'kp'] });

      expect(outcome).toMatchObject({
        status: 'applied',
        changedKeys: ['maxSubscriptionAmount', 'restrictedJurisdictions'],
        evidence: { sequence: 1, hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
      expect(policy.getPolicyConfiguration().maxSubscriptionAmount).toBe(BigInt(500000));
      expect(policy.getPolicyConfiguration().restrictedJurisdictions).toEqual(['IR', 'KP']);

      const [entry] = history();
      expect(entry).toMatchObject({
        action: 'policy.config.updated',
        actor: ADMIN,
        reason: 'tighten limits',
        before: { config: expect.objectContaining({ maxSubscriptionAmount: '1000000000000', restrictedJurisdictions: [] }) },
        after: {
          changeId: 'chg-1',
          changedKeys: ['maxSubscriptionAmount', 'restrictedJurisdictions'],
          config: expect.objectContaining({ maxSubscriptionAmount: '500000', restrictedJurisdictions: ['IR', 'KP'] }),
        },
      });
      expect((await audit.verifyEntity(POLICY_CONFIG_ENTITY_TYPE, POLICY_CONFIG_ENTITY_ID)).ok).toBe(true);
    });

    it('records nothing for a change that leaves every value as it is', async () => {
      const outcome = await change('chg-noop', { maturityWarningDays: 7 });

      expect(outcome).toMatchObject({ status: 'unchanged', changedKeys: [], evidence: null });
      expect(history()).toHaveLength(0);
    });

    it('produces an exportable, verifiable evidence bundle for the change history', async () => {
      process.env.AUDIT_EVIDENCE_PEPPER = 'p'.repeat(64);
      try {
        await change('chg-1', { minSubscriptionAmount: '5000' });
        const bundle = await audit.exportEvidenceBundle(POLICY_CONFIG_ENTITY_TYPE, POLICY_CONFIG_ENTITY_ID, 'CASE-408', ADMIN);
        expect(bundle.chainHead).toBe(history()[0].hash);
      } finally {
        delete process.env.AUDIT_EVIDENCE_PEPPER;
      }
    });
  });

  describe('failure path', () => {
    it.each([
      ['an unknown setting', { kycBypass: true }, /Unknown policy setting/],
      ['a numeric amount instead of an integer string', { maxSubscriptionAmount: 500 }, /non-negative integer string/],
      ['a negative number', { maturityWarningDays: -1 }, /non-negative number/],
      ['a penalty above 100%', { redeemptionPenaltyPercentage: 101 }, /at most 100/],
      ['a malformed jurisdiction', { restrictedJurisdictions: ['U$'] }, /jurisdiction codes/],
      ['min above max', { minSubscriptionAmount: '2000000000000' }, /must not exceed/],
      ['an empty update', {}, /non-empty object/],
    ])('rejects %s, leaves the configuration untouched and records the attempt', async (_label, updates, message) => {
      const before = policy.getPolicyConfiguration();

      await expect(change('chg-bad', updates)).rejects.toThrow(message);

      expect(policy.getPolicyConfiguration()).toEqual(before);
      expect(history()).toEqual([
        expect.objectContaining({
          action: 'policy.config.rejected',
          actor: ADMIN,
          after: expect.objectContaining({ changeId: 'chg-bad', error: expect.stringMatching(message) }),
        }),
      ]);
    });

    it.each([
      ['a blank reason', { changeId: 'c', reason: '  ' }],
      ['a missing change id', { changeId: '', reason: 'r' }],
    ])('rejects %s before touching anything', async (_label, envelope) => {
      await expect(
        service.apply({ ...envelope, actor: ADMIN, updates: { maturityWarningDays: 3 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(history()).toHaveLength(0);
    });

    it('refuses the change when its evidence cannot be recorded (no evidence, no change)', async () => {
      jest.spyOn(audit, 'record').mockResolvedValueOnce({ kind: 'rejected', rejectReason: 'audit chain at capacity', record: null });
      const before = policy.getPolicyConfiguration();

      await expect(change('chg-cap', { maturityWarningDays: 14 })).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(policy.getPolicyConfiguration()).toEqual(before);
    });
  });

  describe('retry path', () => {
    it('returns the original outcome for a retried change id, without re-applying or re-recording', async () => {
      const first = await change('chg-retry', { maturityWarningDays: 14 });
      policy.updatePolicyConfiguration({ maturityWarningDays: 21 }); // later drift must not be undone by the retry

      const retried = await change('chg-retry', { maturityWarningDays: 14 });

      expect(retried).toEqual(first);
      expect(history()).toHaveLength(1);
      expect(policy.getPolicyConfiguration().maturityWarningDays).toBe(21);
    });

    it('rejects a reused change id with a different body as a conflict', async () => {
      await change('chg-retry', { maturityWarningDays: 14 });
      await expect(change('chg-retry', { maturityWarningDays: 30 })).rejects.toBeInstanceOf(ConflictException);
      expect(history()).toHaveLength(1);
    });

    it('lets a corrected request reuse the id of a rejected attempt', async () => {
      await expect(change('chg-fix', { maturityWarningDays: -5 })).rejects.toThrow();
      await expect(change('chg-fix', { maturityWarningDays: 5 })).resolves.toMatchObject({ status: 'applied' });
      expect(history().map((entry) => entry.action)).toEqual(['policy.config.rejected', 'policy.config.updated']);
    });

    it('serializes concurrent changes so each records the state it actually replaced', async () => {
      await Promise.all([
        change('chg-a', { maturityWarningDays: 10 }),
        change('chg-b', { maturityWarningDays: 20 }),
      ]);

      const [a, b] = history();
      expect(a.after?.config.maturityWarningDays).toBe(10);
      expect(b.before?.config.maturityWarningDays).toBe(10);
      expect(policy.getPolicyConfiguration().maturityWarningDays).toBe(20);
    });
  });

  describe('rollback', () => {
    const rollback = (changeId: string, targetChangeId: string) =>
      service.rollback({ changeId, targetChangeId, actor: ADMIN, reason: 'revert bad limit' });

    it('restores only the keys the target changed, as a new evidenced change', async () => {
      await change('chg-1', { maxSubscriptionAmount: '500000' });
      await change('chg-2', { maturityWarningDays: 30 });

      const outcome = await rollback('rb-1', 'chg-1');

      expect(outcome).toMatchObject({ status: 'applied', changedKeys: ['maxSubscriptionAmount'] });
      expect(policy.getPolicyConfiguration().maxSubscriptionAmount).toBe(BigInt('1000000000000'));
      expect(policy.getPolicyConfiguration().maturityWarningDays).toBe(30);
      expect(history().at(-1)).toMatchObject({
        action: 'policy.config.rolled_back',
        after: expect.objectContaining({ changeId: 'rb-1', rolledBack: 'chg-1' }),
      });
      expect(history()).toHaveLength(3); // history is appended, never rewritten
    });

    it('is idempotent on retry', async () => {
      await change('chg-1', { maxSubscriptionAmount: '500000' });
      const first = await rollback('rb-1', 'chg-1');
      await expect(rollback('rb-1', 'chg-1')).resolves.toEqual(first);
      expect(history()).toHaveLength(2);
    });

    it('refuses an unknown or rejected target', async () => {
      await expect(change('chg-bad', { maturityWarningDays: -1 })).rejects.toThrow();
      await expect(rollback('rb-1', 'chg-bad')).rejects.toBeInstanceOf(NotFoundException);
      await expect(rollback('rb-2', 'never-applied')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to roll back from a history that fails verification', async () => {
      await change('chg-1', { maxSubscriptionAmount: '500000' });
      await change('chg-2', { maturityWarningDays: 30 });
      audit.removeEntryAt(POLICY_CONFIG_ENTITY_TYPE, POLICY_CONFIG_ENTITY_ID, 0);

      await expect(rollback('rb-1', 'chg-2')).rejects.toBeInstanceOf(ConflictException);
      expect(policy.getPolicyConfiguration().maturityWarningDays).toBe(30);
    });
  });
});
