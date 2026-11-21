import {
  assertConserved,
  Dispute,
  DisputeActor,
  DisputeError,
  DisputeLifecycle,
  InMemoryDisputeStore,
  OpenDisputeInput,
  SettlementPort,
} from './dispute-lifecycle';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CID_V0 = 'Qm' + '1'.repeat(44);

const CLAIMANT: DisputeActor = { id: 'holder-1' };
const RESPONDENT: DisputeActor = { id: 'issuer-1' };
const ARBITER: DisputeActor = { id: 'arb-1', roles: ['arbiter'] };
const ADMIN: DisputeActor = { id: 'ops', roles: ['admin'] };
const STRANGER: DisputeActor = { id: 'someone-else' };

const INPUT: OpenDisputeInput = {
  idempotencyKey: 'k-1',
  subjectId: 'bond-42',
  respondentId: RESPONDENT.id,
  amount: '1000000',
  reason: 'coupon 3 underpaid',
};

/** A ledger that records holds and payouts and can be told to fail. */
class FakeLedger implements SettlementPort {
  held = new Map<string, bigint>();
  paid = new Map<string, { toClaimant: bigint; toRespondent: bigint }>();
  settleCalls = 0;
  failHold = false;
  failSettle = 0;
  failRelease = false;

  hold(id: string, amount: bigint) {
    if (this.failHold) throw new Error('ledger down');
    this.held.set(id, amount);
  }

  release(id: string) {
    if (this.failRelease) throw new Error('release down');
    this.held.delete(id);
  }

  settle(id: string, toClaimant: bigint, toRespondent: bigint) {
    this.settleCalls += 1;
    if (this.failSettle > 0) {
      this.failSettle -= 1;
      throw new Error('ledger timeout');
    }
    const prior = this.paid.get(id);
    if (prior && (prior.toClaimant !== toClaimant || prior.toRespondent !== toRespondent)) {
      throw new Error('double settlement with a different split');
    }
    this.paid.set(id, { toClaimant, toRespondent });
  }

  /** Total paid out for a dispute never exceeds what was held. */
  conserved(id: string): boolean {
    const p = this.paid.get(id);
    return p !== undefined && p.toClaimant + p.toRespondent === this.held.get(id);
  }
}

const setup = (opts: { now?: number } = {}) => {
  let now = opts.now ?? T0;
  const store = new InMemoryDisputeStore();
  const ledger = new FakeLedger();
  const svc = new DisputeLifecycle(store, ledger, {
    evidenceWindowMs: 7 * DAY,
    reviewWindowMs: 14 * DAY,
    maxEvidencePerParty: 3,
    clock: () => now,
  });
  return {
    store,
    ledger,
    svc,
    at: (t: number) => {
      now = t;
    },
  };
};

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(DisputeError);
  await expect(p).rejects.toMatchObject({ code });
};

describe('DisputeLifecycle (#625)', () => {
  describe('normal path', () => {
    it('opens a dispute, holds the amount, and sets both deadlines', async () => {
      const { svc, ledger } = setup();
      const d = await svc.open(CLAIMANT, INPUT);

      expect(d).toMatchObject({
        status: 'open',
        claimantId: 'holder-1',
        respondentId: 'issuer-1',
        amount: '1000000',
        evidenceDeadline: T0 + 7 * DAY,
        resolutionDeadline: T0 + 21 * DAY,
        version: 1,
      });
      expect(ledger.held.get(d.id)).toBe(1000000n);
    });

    it('runs evidence → review → ruling end to end and pays the split', async () => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      await svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'payment receipt' });
      await svc.submitEvidence(RESPONDENT, d.id, { contentHash: CID_V0, description: 'coupon schedule' });

      at(T0 + 7 * DAY);
      const sweep = await svc.sweep(ADMIN);
      expect(sweep.reviewStarted).toEqual([d.id]);
      expect((await svc.get(ARBITER, d.id)).status).toBe('under_review');

      const resolved = await svc.resolve(ARBITER, d.id, { outcome: 'split', toClaimant: '400000', rationale: 'partial' });
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolution).toMatchObject({ outcome: 'split', toClaimant: '400000', toRespondent: '600000' });
      expect(resolved.pendingSettlement).toBeUndefined();
      expect(ledger.paid.get(d.id)).toEqual({ toClaimant: 400000n, toRespondent: 600000n });
      expect(ledger.conserved(d.id)).toBe(true);
      expect(resolved.history.map((h) => h.type)).toEqual([
        'opened',
        'evidence_submitted',
        'evidence_submitted',
        'review_started',
        'settlement_started',
        'resolved',
      ]);
    });

    it.each([
      ['upheld', 1000000n, 0n],
      ['rejected', 0n, 1000000n],
    ] as const)('%s pays the whole amount to one side', async (outcome, toClaimant, toRespondent) => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      await svc.resolve(ARBITER, d.id, { outcome, rationale: 'ruling' });
      expect(ledger.paid.get(d.id)).toEqual({ toClaimant, toRespondent });
    });

    it('lets the claimant withdraw, returning funds to the respondent', async () => {
      const { svc, ledger } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      const w = await svc.withdraw(CLAIMANT, d.id);
      expect(w.status).toBe('withdrawn');
      expect(ledger.paid.get(d.id)).toEqual({ toClaimant: 0n, toRespondent: 1000000n });
    });

    it('expires an unruled dispute at the resolution deadline in favour of the status quo', async () => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 21 * DAY);
      const report = await svc.sweep(ADMIN);
      expect(report.expired).toEqual([d.id]);
      expect((await svc.get(ADMIN, d.id)).status).toBe('expired');
      expect(ledger.paid.get(d.id)).toEqual({ toClaimant: 0n, toRespondent: 1000000n });
    });

    it('accepts a new dispute on the same subject once the previous one is final', async () => {
      const { svc } = setup();
      const first = await svc.open(CLAIMANT, INPUT);
      await svc.withdraw(CLAIMANT, first.id);
      const second = await svc.open(CLAIMANT, { ...INPUT, idempotencyKey: 'k-2' });
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('deadlines and state', () => {
    it('rejects evidence at or after the evidence deadline', async () => {
      const { svc, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 7 * DAY);
      await expectCode(svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'late' }), 'deadline_passed');
    });

    it('rejects a ruling while the evidence window is open', async () => {
      const { svc, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 7 * DAY - 1);
      await expectCode(svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' }), 'invalid_state');
    });

    it('rejects a ruling at or after the resolution deadline even before the sweep runs', async () => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 21 * DAY);
      await expectCode(svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' }), 'deadline_passed');
      expect(ledger.settleCalls).toBe(0);
    });

    it('does not accept evidence or withdrawal after resolution', async () => {
      const { svc, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      await svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' });
      await expectCode(svc.withdraw(CLAIMANT, d.id), 'invalid_state');
      at(T0 + 1);
      await expectCode(svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_B, description: 'x' }), 'invalid_state');
    });

    it('caps evidence per party', async () => {
      const { svc } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      for (const c of ['1', '2', '3']) {
        await svc.submitEvidence(CLAIMANT, d.id, { contentHash: c.repeat(64), description: c });
      }
      await expectCode(svc.submitEvidence(CLAIMANT, d.id, { contentHash: '4'.repeat(64), description: '4' }), 'invalid');
      // the cap is per party
      await svc.submitEvidence(RESPONDENT, d.id, { contentHash: HASH_A, description: 'r' });
    });

    it('leaves final disputes alone in the sweep', async () => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      await svc.withdraw(CLAIMANT, d.id);
      at(T0 + 30 * DAY);
      const report = await svc.sweep(ADMIN);
      expect(report).toEqual({ reviewStarted: [], expired: [], completed: [], failed: [] });
      expect(ledger.settleCalls).toBe(1);
    });
  });

  describe('validation', () => {
    it.each([
      [{ amount: '0' }],
      [{ amount: '-5' }],
      [{ amount: '1.5' }],
      [{ amount: '01' }],
      [{ amount: '9'.repeat(30) }],
      [{ reason: '   ' }],
      [{ subjectId: '' }],
      [{ respondentId: CLAIMANT.id }],
      [{ reason: 'x'.repeat(2001) }],
    ])('rejects bad open input %j', async (patch) => {
      const { svc, ledger } = setup();
      await expectCode(svc.open(CLAIMANT, { ...INPUT, ...patch } as OpenDisputeInput), 'invalid');
      expect(ledger.held.size).toBe(0);
    });

    it('rejects evidence that is not a sha256 digest or CID', async () => {
      const { svc } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      await expectCode(svc.submitEvidence(CLAIMANT, d.id, { contentHash: 'not-a-hash', description: 'x' }), 'invalid');
    });

    it.each([
      [{ outcome: 'split', toClaimant: '1000001', rationale: 'x' }],
      [{ outcome: 'split', toClaimant: '-1', rationale: 'x' }],
      [{ outcome: 'split', rationale: 'x' }],
      [{ outcome: 'maybe', rationale: 'x' }],
      [{ outcome: 'upheld', rationale: '' }],
    ])('rejects a ruling %j without paying anything', async (ruling) => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      await expectCode(svc.resolve(ARBITER, d.id, ruling as never), 'invalid');
      expect(ledger.settleCalls).toBe(0);
      expect((await svc.get(ARBITER, d.id)).pendingSettlement).toBeUndefined();
    });

    it('returns not_found for an unknown dispute', async () => {
      const { svc } = setup();
      await expectCode(svc.get(ADMIN, 'dsp_missing'), 'not_found');
    });
  });

  describe('authorization', () => {
    it('requires an authenticated actor', async () => {
      const { svc } = setup();
      await expectCode(svc.open({ id: '' }, INPUT), 'forbidden');
    });

    it('hides a dispute from non-parties but shows it to parties, arbiters and admins', async () => {
      const { svc } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      await expectCode(svc.get(STRANGER, d.id), 'forbidden');
      for (const a of [CLAIMANT, RESPONDENT, ARBITER, ADMIN]) {
        await expect(svc.get(a, d.id)).resolves.toMatchObject({ id: d.id });
      }
    });

    it('accepts evidence only from the two parties', async () => {
      const { svc } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      for (const a of [STRANGER, ARBITER, ADMIN]) {
        await expectCode(svc.submitEvidence(a, d.id, { contentHash: HASH_A, description: 'x' }), 'forbidden');
      }
    });

    it('lets only a non-party arbiter rule', async () => {
      const { svc, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      const ruling = { outcome: 'upheld' as const, rationale: 'x' };
      await expectCode(svc.resolve(ADMIN, d.id, ruling), 'forbidden');
      await expectCode(svc.resolve(CLAIMANT, d.id, ruling), 'forbidden');
      await expectCode(svc.resolve({ id: RESPONDENT.id, roles: ['arbiter'] }, d.id, ruling), 'forbidden');
    });

    it('lets only the claimant withdraw', async () => {
      const { svc } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      await expectCode(svc.withdraw(RESPONDENT, d.id), 'forbidden');
      await expectCode(svc.withdraw(ADMIN, d.id), 'forbidden');
    });

    it('restricts sweep to admins', async () => {
      const { svc } = setup();
      await expectCode(svc.sweep(ARBITER), 'forbidden');
    });

    it('scopes idempotency keys per claimant so one user cannot collide with another', async () => {
      const { svc } = setup();
      const a = await svc.open(CLAIMANT, INPUT);
      const b = await svc.open({ id: 'holder-2' }, INPUT);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('retry and idempotency', () => {
    it('returns the same dispute for a retried open and holds only once', async () => {
      const { svc, ledger } = setup();
      const holdSpy = jest.spyOn(ledger, 'hold');
      const a = await svc.open(CLAIMANT, INPUT);
      const b = await svc.open(CLAIMANT, INPUT);
      expect(b).toEqual(a);
      expect(holdSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects an idempotency key reused with a different payload', async () => {
      const { svc } = setup();
      await svc.open(CLAIMANT, INPUT);
      await expectCode(svc.open(CLAIMANT, { ...INPUT, amount: '2' }), 'conflict');
    });

    it('rejects a second active dispute on the same subject with a new key', async () => {
      const { svc } = setup();
      await svc.open(CLAIMANT, INPUT);
      await expectCode(svc.open(CLAIMANT, { ...INPUT, idempotencyKey: 'k-2' }), 'conflict');
    });

    it('treats resubmitted evidence from the same party as a no-op', async () => {
      const { svc, store } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      const e1 = await svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'x' });
      const e2 = await svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'x again' });
      expect(e2).toEqual(e1);
      expect(store.get(d.id)!.evidence).toHaveLength(1);
    });

    it('returns an applied ruling unchanged when retried, and refuses a different one', async () => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      const r1 = await svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' });
      const r2 = await svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' });
      expect(r2).toEqual(r1);
      expect(ledger.settleCalls).toBe(1);
      await expectCode(svc.resolve(ARBITER, d.id, { outcome: 'rejected', rationale: 'x' }), 'conflict');
    });

    it('treats a repeated withdrawal as a no-op', async () => {
      const { svc, ledger } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      await svc.withdraw(CLAIMANT, d.id);
      await svc.withdraw(CLAIMANT, d.id);
      expect(ledger.settleCalls).toBe(1);
    });
  });

  describe('failure and recovery', () => {
    it('records nothing when the hold fails, and a retry succeeds', async () => {
      const { svc, store, ledger } = setup();
      ledger.failHold = true;
      const p = svc.open(CLAIMANT, INPUT);
      await expectCode(p, 'hold_failed');
      await p.catch((e: DisputeError) => expect(e.retryable).toBe(true));
      expect(store.list()).toHaveLength(0);

      ledger.failHold = false;
      const d = await svc.open(CLAIMANT, INPUT);
      expect(ledger.held.get(d.id)).toBe(1000000n);
    });

    it('releases the hold when the dispute cannot be stored', async () => {
      const { svc, store, ledger } = setup();
      jest.spyOn(store, 'save').mockImplementationOnce(() => {
        throw new Error('db down');
      });
      await expect(svc.open(CLAIMANT, INPUT)).rejects.toThrow('db down');
      expect(ledger.held.size).toBe(0);
      expect(store.list()).toHaveLength(0);
    });

    it('flags the hold for reconciliation when both the write and the release fail', async () => {
      const { svc, store, ledger } = setup();
      ledger.failRelease = true;
      jest.spyOn(store, 'save').mockImplementationOnce(() => {
        throw new Error('db down');
      });
      await expect(svc.open(CLAIMANT, INPUT)).rejects.toThrow(/reconcile hold dsp_/);
    });

    it('keeps the hold when a concurrent identical open already stored the dispute', async () => {
      const { svc, store, ledger } = setup();
      const realSave = store.save.bind(store);
      jest.spyOn(store, 'save').mockImplementationOnce((d: Dispute, v: number) => {
        realSave(d, v); // the "other" request wins the race
        throw new DisputeError('conflict', 'lost race');
      });
      const d = await svc.open(CLAIMANT, INPUT);
      expect(ledger.held.get(d.id)).toBe(1000000n);
      expect(store.list()).toHaveLength(1);
    });

    it('keeps the ruling pending when settlement fails, then finishes it on retry', async () => {
      const { svc, store, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      ledger.failSettle = 1;
      const ruling = { outcome: 'split' as const, toClaimant: '250000', rationale: 'x' };

      await expectCode(svc.resolve(ARBITER, d.id, ruling), 'settlement_failed');
      const mid = store.get(d.id)!;
      expect(mid.status).toBe('open');
      expect(mid.pendingSettlement).toMatchObject({ status: 'resolved', toClaimant: '250000' });
      expect(ledger.paid.size).toBe(0);

      // Nothing else may start while the ruling is mid-settlement.
      await expectCode(svc.withdraw(CLAIMANT, d.id), 'conflict');
      await expectCode(svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' }), 'conflict');
      await expectCode(svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'x' }), 'invalid_state');

      const done = await svc.resolve(ARBITER, d.id, ruling);
      expect(done.status).toBe('resolved');
      expect(ledger.conserved(d.id)).toBe(true);
    });

    it('lets the sweep finish an interrupted settlement, even after the deadline', async () => {
      const { svc, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      ledger.failSettle = 1;
      await expectCode(svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' }), 'settlement_failed');

      at(T0 + 30 * DAY);
      const report = await svc.sweep(ADMIN);
      expect(report.completed).toEqual([d.id]);
      expect(report.expired).toEqual([]);
      const final = await svc.get(ADMIN, d.id);
      expect(final.status).toBe('resolved');
      expect(ledger.paid.get(d.id)).toEqual({ toClaimant: 1000000n, toRespondent: 0n });
    });

    it('reports one failing dispute without stopping the sweep', async () => {
      const { svc, ledger, at } = setup();
      const a = await svc.open(CLAIMANT, INPUT);
      const b = await svc.open({ id: 'holder-2' }, INPUT);
      at(T0 + 21 * DAY);
      ledger.failSettle = 1;
      const report = await svc.sweep(ADMIN);
      expect(report.failed).toEqual([expect.objectContaining({ id: a.id, code: 'settlement_failed' })]);
      expect(report.expired).toEqual([b.id]);

      const retry = await svc.sweep(ADMIN);
      expect(retry.completed).toEqual([a.id]);
      expect(ledger.conserved(a.id)).toBe(true);
    });

    it('lets only one of two racing finalizations pay out', async () => {
      const { svc, store, ledger, at } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      at(T0 + 8 * DAY);
      // Withdrawal reads the dispute, then a ruling lands before it writes.
      const stale = store.get(d.id)!;
      await svc.resolve(ARBITER, d.id, { outcome: 'upheld', rationale: 'x' });
      jest.spyOn(store, 'get').mockReturnValueOnce(stale);

      await expectCode(svc.withdraw(CLAIMANT, d.id), 'conflict');
      expect(ledger.settleCalls).toBe(1);
      expect(ledger.paid.get(d.id)).toEqual({ toClaimant: 1000000n, toRespondent: 0n });
    });

    it('reports a lost evidence write as a retryable conflict', async () => {
      const { svc, store } = setup();
      const d = await svc.open(CLAIMANT, INPUT);
      const stale = store.get(d.id)!;
      await svc.submitEvidence(RESPONDENT, d.id, { contentHash: HASH_B, description: 'r' });
      jest.spyOn(store, 'get').mockReturnValueOnce(stale);
      const p = svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'c' });
      await expectCode(p, 'conflict');

      await svc.submitEvidence(CLAIMANT, d.id, { contentHash: HASH_A, description: 'c' });
      expect(store.get(d.id)!.evidence).toHaveLength(2);
    });
  });

  describe('financial invariants', () => {
    it('assertConserved rejects splits that do not sum to the held amount', () => {
      expect(() => assertConserved(10n, 4n, 6n)).not.toThrow();
      expect(() => assertConserved(10n, 4n, 5n)).toThrow(DisputeError);
      expect(() => assertConserved(10n, 11n, -1n)).toThrow(DisputeError);
    });

    it('never settles a dispute more than once across every terminal path', async () => {
      const { svc, ledger, at } = setup();
      const a = await svc.open(CLAIMANT, INPUT);
      const b = await svc.open({ id: 'holder-2' }, INPUT);
      const c = await svc.open({ id: 'holder-3' }, INPUT);
      await svc.withdraw(CLAIMANT, a.id);
      at(T0 + 8 * DAY);
      await svc.resolve(ARBITER, b.id, { outcome: 'split', toClaimant: '1', rationale: 'x' });
      at(T0 + 21 * DAY);
      await svc.sweep(ADMIN);
      await svc.sweep(ADMIN);

      expect(ledger.settleCalls).toBe(3);
      for (const d of [a, b, c]) expect(ledger.conserved(d.id)).toBe(true);
    });

    it('rejects non-positive windows at construction', () => {
      expect(() => new DisputeLifecycle(new InMemoryDisputeStore(), new FakeLedger(), { evidenceWindowMs: 0 })).toThrow(
        DisputeError,
      );
    });
  });
});
