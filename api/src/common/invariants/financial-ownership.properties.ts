/**
 * Reference model + generators for property tests over the protocol's
 * financial and ownership invariants.
 *
 * The model is intentionally independent of the persistence layer: it encodes
 * the rules the API/contracts must obey (conservation of subscribed tokens,
 * positive balances, admin/owner-only transfers, idempotent retries) and then
 * asks the *production* invariant helpers in `domain-invariants.ts` to confirm
 * the resulting state is legal. If either the model or the invariants drift,
 * a property fails with a shrunken counterexample.
 *
 * Nothing here mutates live state; it is executable verification only.
 */

import { Rng } from './property-harness';
import { InvariantResult, ownershipInvariants, bondLifecycleInvariants } from './domain-invariants';

const ADDRESS_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split('');

/** Valid-looking Stellar address (INV-006 only checks `G` + 55 chars). */
export function makeAddress(rng: Rng, tag: string): string {
  const rest = 55 - tag.length;
  let suffix = '';
  for (let i = 0; i < rest; i++) suffix += rng.pick(ADDRESS_CHARS);
  return `G${tag}${suffix}`;
}

export interface OwnershipState {
  bondId: number;
  /** Full precision: financial values are bigint, never Number. */
  totalSupply: bigint;
  balances: Map<string, bigint>;
  totalSubscribed: bigint;
  admin: string;
}

export interface TransferCase {
  state: OwnershipState;
  from: string;
  to: string;
  amount: bigint;
  actor: string;
  /** Idempotency key; a replay with a used key is a no-op. */
  key: string;
  appliedKeys: Set<string>;
}

export interface TransferOutcome {
  applied: boolean;
  reason?: 'not-authorized' | 'invalid-amount' | 'insufficient-balance' | 'duplicate';
  state: OwnershipState;
}

/** Produce a *valid* ownership state (all financial invariants hold). */
export function generateOwnershipState(rng: Rng): OwnershipState {
  const count = rng.int(1, 4);
  const admin = makeAddress(rng, 'ADMIN');
  const balances = new Map<string, bigint>();
  for (let i = 0; i < count; i++) {
    // Small values most of the time, occasionally > Number.MAX_SAFE_INTEGER.
    const value = rng.bool(0.15) ? rng.bigint(100) + 1n : BigInt(rng.int(1, 1000));
    balances.set(makeAddress(rng, `H${i}`), value);
  }
  const totalSubscribed = [...balances.values()].reduce((sum, value) => sum + value, 0n);
  return {
    bondId: rng.int(1, 1000),
    totalSupply: totalSubscribed + rng.bigint(6), // unissued headroom >= 0
    balances,
    totalSubscribed,
    admin,
  };
}

export function generateTransferCase(rng: Rng, state = generateOwnershipState(rng)): TransferCase {
  const holders = [...state.balances.keys()];
  const from = rng.pick(holders);
  const to = rng.pick(holders);
  const fromBalance = state.balances.get(from)!;
  // Mostly a legal amount, sometimes an overdraw to exercise the rejection path.
  const amount = rng.bool(0.85)
    ? (rng.bigint(4) % fromBalance) + 1n
    : fromBalance + rng.bigint(4) + 1n;
  const stranger = makeAddress(rng, 'STRANGER');
  const actor = rng.pick([from, state.admin, stranger]);
  const key = `idem-${rng.int(0, 3)}`;
  const appliedKeys = new Set<string>();
  if (rng.bool(0.2)) appliedKeys.add(key); // simulate a replayed request
  return { state, from, to, amount, actor, key, appliedKeys };
}

/** Simpler variants of a failing case, used by the harness' shrinking loop. */
export function shrinkTransferCase(input: TransferCase): TransferCase[] {
  const { state, from, to, actor, key, appliedKeys } = input;
  const holders = [...state.balances.keys()];
  const candidates: TransferCase[] = [];

  // Smaller amounts first; the boundaries are where accounting bugs hide.
  const fromBalance = state.balances.get(from) ?? 0n;
  for (const amount of [0n, 1n, fromBalance, fromBalance + 1n]) {
    candidates.push({ ...input, amount });
  }

  // Authorized / admin / stranger actors.
  for (const nextActor of [from, state.admin]) {
    candidates.push({ ...input, actor: nextActor });
  }

  // Fewer holders, then smaller balances, then no unissued headroom.
  if (holders.length > 1) {
    const trimmed = new Map(state.balances);
    const removable = holders.find((h) => h !== from && h !== to);
    if (removable) {
      trimmed.delete(removable);
      candidates.push({ ...input, state: withBalances(state, trimmed) });
    }
  }
  const halved = new Map([...state.balances].map(([h, v]) => [h, v / 2n > 0n ? v / 2n : 1n]));
  candidates.push({ ...input, state: withBalances(state, halved) });
  candidates.push({ ...input, state: { ...state, totalSupply: state.totalSubscribed, bondId: 1 } });

  // A replay with no previously applied key.
  if (appliedKeys.size > 0) candidates.push({ ...input, appliedKeys: new Set<string>() });

  return candidates;
}

function withBalances(state: OwnershipState, balances: Map<string, bigint>): OwnershipState {
  return {
    ...state,
    balances,
    totalSubscribed: [...balances.values()].reduce((sum, value) => sum + value, 0n),
    totalSupply: [...balances.values()].reduce((sum, value) => sum + value, 0n),
  };
}

export function isAuthorized(input: TransferCase): boolean {
  return input.actor === input.from || input.actor === input.state.admin;
}

/**
 * Pure reference implementation of a transfer. Never mutates the input.
 * Mirrors the API contract: owner/admin only, positive amount, sufficient
 * balance, and an idempotency key that may be replayed safely.
 */
export function applyTransfer(input: TransferCase): TransferOutcome {
  const { state, from, to, amount, actor, key, appliedKeys } = input;
  if (!isAuthorized(input)) return { applied: false, reason: 'not-authorized', state };
  if (amount <= 0n) return { applied: false, reason: 'invalid-amount', state };
  if (appliedKeys.has(key)) return { applied: false, reason: 'duplicate', state };
  if (!state.balances.has(from) || !state.balances.has(to)) {
    return { applied: false, reason: 'insufficient-balance', state };
  }
  if (state.balances.get(from)! < amount) {
    return { applied: false, reason: 'insufficient-balance', state };
  }

  // A transfer to self is a legal no-op; it must not zero out the holder.
  if (from === to) return { applied: true, state };

  const balances = new Map(state.balances);
  const remaining = balances.get(from)! - amount;
  // A holder whose balance reaches zero leaves the holder index (INV-004).
  if (remaining === 0n) balances.delete(from);
  else balances.set(from, remaining);
  balances.set(to, balances.get(to)! + amount);
  return {
    applied: true,
    state: { ...state, balances },
  };
}

export function snapshot(state: OwnershipState): {
  holderBalances: Record<string, string>;
  totalSubscribed: string;
  totalSupply: string;
} {
  return {
    holderBalances: Object.fromEntries([...state.balances].map(([h, v]) => [h, v.toString()])),
    totalSubscribed: state.totalSubscribed.toString(),
    totalSupply: state.totalSupply.toString(),
  };
}

/** Run the *production* invariants against a reference-model state. */
export async function invariantsFor(state: OwnershipState): Promise<InvariantResult[]> {
  const s = snapshot(state);
  return Promise.all([
    bondLifecycleInvariants.subscribedDoesNotExceedSupply(s.totalSubscribed, s.totalSupply),
    ownershipInvariants.holderBalancesSumEqualsTotalSubscribed(s.holderBalances, s.totalSubscribed),
    ...[...state.balances].map(([address, balance]) =>
      Promise.all([
        ownershipInvariants.holderBalanceIsPositive(address, balance.toString()),
        ownershipInvariants.holderAddressIsValid(address),
      ]),
    ),
  ]).then((results) => results.flat() as InvariantResult[]);
}

/**
 * Deliberately break conservation/positivity *without* recomputing the cached
 * totalSubscribed — exactly the drift between holder index and bond state that
 * INV-005 exists to catch.
 */
export function corrupt(state: OwnershipState, mode: 'create' | 'lose' | 'zero'): OwnershipState {
  const balances = new Map(state.balances);
  const [first] = [...balances.keys()];
  if (mode === 'zero') balances.set(first, 0n);
  else balances.set(first, balances.get(first)! + (mode === 'create' ? 1n : -1n));
  return { ...state, balances };
}
