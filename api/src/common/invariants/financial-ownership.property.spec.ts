/**
 * Property tests for financial and ownership invariants.
 *
 * Every case is generated from a fixed seed, so a failure is reproducible with
 * the exact counterexample printed by `assertProperty`. The suite covers the
 * four required paths explicitly:
 *   normal      — legal transfers keep all invariants true
 *   failure     — overdraw/invalid/corrupted state is rejected or detected
 *   retry       — an idempotency replay never double-applies; seeds replay
 *   authorization — only the holder or admin may move a holder's balance
 */

import { assertProperty, checkProperty, mulberry32, Rng } from './property-harness';
import {
  applyTransfer,
  corrupt,
  generateOwnershipState,
  generateTransferCase,
  invariantsFor,
  isAuthorized,
  makeAddress,
  OwnershipState,
  shrinkTransferCase,
  snapshot,
  TransferCase,
} from './financial-ownership.properties';
import { accessControlInvariants } from './domain-invariants';

const SEED = 0x76657264; // "verd"
const OPTS = { seed: SEED, runs: 150, shrink: shrinkTransferCase };

function allPass(results: { passed: boolean }[]): boolean {
  return results.every((r) => r.passed);
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    return v;
  });
}

describe('Financial & ownership properties', () => {
  describe('normal paths', () => {
    it('generated valid states satisfy INV-001, INV-004, INV-005 and INV-006', async () => {
      await assertProperty(
        (rng) => generateOwnershipState(rng),
        async (state) => allPass(await invariantsFor(state)),
        {
          seed: SEED,
          runs: 150,
          shrink: (state: OwnershipState) => [
            { ...state, bondId: 1, totalSupply: state.totalSubscribed },
            { ...state, balances: new Map([...state.balances].slice(0, 1)), totalSubscribed: state.totalSubscribed },
          ],
        },
      );
    });

    it('a legal transfer conserves subscribed tokens and keeps balances positive', async () => {
      await assertProperty(
        (rng) => generateTransferCase(rng),
        async (input) => {
          const outcome = applyTransfer(input);
          // Whether or not this particular case was accepted, the resulting
          // state must never violate an invariant.
          return allPass(await invariantsFor(outcome.state));
        },
        OPTS,
      );
    });

    it('a successful transfer moves exactly the requested amount', async () => {
      await assertProperty(
        (rng) => generateTransferCase(rng),
        (input) => {
          const outcome = applyTransfer(input);
          if (!outcome.applied) return true;
          const before = input.state.balances;
          const after = outcome.state.balances;
          if (input.from === input.to) {
            // Self-transfer must net to zero and keep the holder listed.
            return stable(outcome.state) === stable(input.state);
          }
          const expectedFrom = before.get(input.from)! - input.amount;
          return (
            (expectedFrom === 0n ? !after.has(input.from) : after.get(input.from) === expectedFrom) &&
            after.get(input.to) === before.get(input.to)! + input.amount &&
            outcome.state.totalSubscribed === input.state.totalSubscribed
          );
        },
        OPTS,
      );
    });
  });

  describe('failure paths', () => {
    it('an overdraw is rejected and leaves the state byte-for-byte unchanged', async () => {
      await assertProperty(
        (rng) => generateTransferCase(rng),
        (input) => {
          const balance = input.state.balances.get(input.from)!;
          if (
            balance >= input.amount ||
            input.amount <= 0n ||
            !isAuthorized(input) ||
            input.appliedKeys.has(input.key)
          ) return true;
          const outcome = applyTransfer(input);
          return outcome.reason === 'insufficient-balance' && stable(outcome.state) === stable(input.state);
        },
        OPTS,
      );
    });

    it('zero and negative amounts are rejected', async () => {
      await assertProperty(
        (rng) => generateTransferCase(rng),
        (input) => {
          if (input.amount > 0n) return true;
          const outcome = applyTransfer(input);
          return outcome.reason === 'invalid-amount' && !outcome.applied;
        },
        OPTS,
      );
    });

    it.each(['create', 'lose', 'zero'] as const)(
      'the invariants detect corrupted balances (mode: %s)',
      async (mode) => {
        const rng = mulberry32(SEED);
        const state = generateOwnershipState(rng);
        const results = await invariantsFor(corrupt(state, mode));
        expect(allPass(results)).toBe(false);
        if (mode === 'zero') {
          expect(results.some((r) => r.code === 'INV-004' && !r.passed)).toBe(true);
        } else {
          expect(results.some((r) => r.code === 'INV-005' && !r.passed)).toBe(true);
        }
        // Recovery/rollback: restoring the original state clears the breach.
        expect(allPass(await invariantsFor(state))).toBe(true);
      },
    );
  });

  describe('retry / idempotency', () => {
    it('a replayed idempotency key never double-applies a transfer', async () => {
      await assertProperty(
        (rng) => generateTransferCase(rng),
        (input) => {
          if (!input.appliedKeys.has(input.key) || !isAuthorized(input) || input.amount <= 0n) return true;
          const outcome = applyTransfer(input);
          return outcome.reason === 'duplicate' && !outcome.applied && stable(outcome.state) === stable(input.state);
        },
        OPTS,
      );
    });

    it('retrying a rejected overdraw with a corrected amount succeeds exactly once', async () => {
      const rng = mulberry32(SEED);
      const state = generateOwnershipState(rng);
      const [from, to] = [...state.balances.keys()];
      const balance = state.balances.get(from)!;
      const overdraw: TransferCase = {
        state, from, to, actor: from, amount: balance + 1n, key: 'retry-1', appliedKeys: new Set(),
      };
      expect(applyTransfer(overdraw).applied).toBe(false);

      const corrected = { ...overdraw, amount: balance };
      const first = applyTransfer(corrected);
      expect(first.applied).toBe(true);

      const replay = { ...corrected, appliedKeys: new Set(['retry-1']) };
      const second = applyTransfer(replay);
      expect(second.applied).toBe(false);
      expect(second.reason).toBe('duplicate');
      // The replay returns the pre-transfer state; nothing is applied twice.
      expect(stable(second.state)).toBe(stable(corrected.state));
    });

    it('re-running a failing property with the same seed reproduces the same minimal case', async () => {
      // Deliberately false property: conservation after a corruption.
      const failing = (rng: Rng): TransferCase => generateTransferCase(rng);
      const predicate = async (input: TransferCase) =>
        allPass(await invariantsFor(corrupt(input.state, 'create')));

      const a = await checkProperty(failing, predicate, OPTS);
      const b = await checkProperty(failing, predicate, OPTS);
      expect(a.passed).toBe(false);
      expect(b.passed).toBe(false);
      expect(a.failure!.run).toBe(b.failure!.run);
      expect(a.failure!.shrinks).toBe(b.failure!.shrinks);
      expect(stable(a.failure!.input)).toBe(stable(b.failure!.input));
    });
  });

  describe('authorization', () => {
    it('only the holder or the admin may move a balance', async () => {
      await assertProperty(
        (rng) => generateTransferCase(rng),
        (input) => {
          const outcome = applyTransfer(input);
          if (!isAuthorized(input)) {
            return outcome.applied === false && outcome.reason === 'not-authorized';
          }
          // Authorized actors may still be blocked by balance/key checks, but
          // never by the authorization rule itself.
          return outcome.reason !== 'not-authorized';
        },
        OPTS,
      );
    });

    it('access-control invariants agree with the generated actor/admin pair', async () => {
      await assertProperty(
        (rng: Rng) => {
          const state = generateOwnershipState(rng);
          return { admin: state.admin, actor: rng.pick([state.admin, makeAddress(rng, 'OTHER')]) };
        },
        ({ actor, admin }) =>
          accessControlInvariants.onlyAdminCanMature(actor, admin).then((r) => r.passed === (actor === admin)),
        { seed: SEED, runs: 100 },
      );
    });

    it('only verified/accredited KYC statuses are eligible to subscribe', async () => {
      await assertProperty(
        (rng: Rng) => rng.pick(['verified', 'accredited', 'none', 'pending', 'expired', 'rejected']),
        (status) =>
          accessControlInvariants.subscriberIsKycVerified(status).then((r) =>
            r.passed === ['verified', 'accredited'].includes(status),
          ),
        { seed: SEED, runs: 100 },
      );
    });
  });

  describe('edge cases', () => {
    it('keeps full precision for balances beyond Number.MAX_SAFE_INTEGER', async () => {
      const huge = 1n << 100n;
      const state: OwnershipState = {
        bondId: 7,
        totalSupply: huge * 2n,
        totalSubscribed: huge * 2n,
        balances: new Map([['G'.padEnd(56, 'A'), huge], ['G'.padEnd(56, 'B'), huge]]),
        admin: 'G'.padEnd(56, 'C'),
      };
      const input: TransferCase = {
        state,
        from: [...state.balances.keys()][0],
        to: [...state.balances.keys()][1],
        amount: huge,
        actor: [...state.balances.keys()][0],
        key: 'huge-1',
        appliedKeys: new Set(),
      };
      const outcome = applyTransfer(input);
      expect(outcome.applied).toBe(true);
      expect(outcome.state.totalSubscribed).toBe(huge * 2n);
      expect(allPass(await invariantsFor(outcome.state))).toBe(true);
    });

    it('handles an empty holder index without creating or losing tokens', async () => {
      const empty: OwnershipState = {
        bondId: 1,
        totalSupply: 0n,
        totalSubscribed: 0n,
        balances: new Map(),
        admin: 'G'.padEnd(56, 'A'),
      };
      expect(allPass(await invariantsFor(empty))).toBe(true);
      const outcome = applyTransfer({
        state: empty,
        from: 'G'.padEnd(56, 'B'),
        to: 'G'.padEnd(56, 'C'),
        amount: 1n,
        actor: empty.admin,
        key: 'empty-1',
        appliedKeys: new Set(),
      });
      expect(outcome.applied).toBe(false);
      expect(stable(outcome.state)).toBe(stable(empty));
    });

    it('allows a self-transfer as a legal no-op on the subscribed total', async () => {
      const rng = mulberry32(SEED);
      const state = generateOwnershipState(rng);
      const [holder] = [...state.balances.keys()];
      const outcome = applyTransfer({
        state, from: holder, to: holder, actor: holder,
        amount: 1n, key: 'self-1', appliedKeys: new Set(),
      });
      expect(outcome.applied).toBe(true);
      expect(outcome.state.totalSubscribed).toBe(state.totalSubscribed);
      expect(allPass(await invariantsFor(outcome.state))).toBe(true);
    });

    it('does not mutate the input state (rollback is just discarding the result)', () => {
      const rng = mulberry32(SEED);
      const input = generateTransferCase(rng);
      const before = stable(input.state);
      applyTransfer(input);
      expect(stable(input.state)).toBe(before);
    });
  });
});
