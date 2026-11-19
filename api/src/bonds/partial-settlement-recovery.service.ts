export type TransferLegStatus = 'PENDING' | 'COMMITTED' | 'ROLLED_BACK' | 'FAILED';

export interface BondTransferStep {
  legId: string;
  execute: () => Promise<void>;
  compensate: () => Promise<void>;
}

export interface PartialSettlementSession {
  settlementId: string;
  bondId: string;
  amount: string;
  actorRole: 'ADMIN' | 'SETTLEMENT_MANAGER' | 'INVESTOR';
  committedLegs: string[];
  rolledBackLegs: string[];
  status: 'COMPLETED' | 'RECOVERED_ROLLED_BACK' | 'PARTIAL_FAILURE';
  attempts: number;
  lastError?: string;
}

export class SettlementRecoveryAuthorizationError extends Error {
  constructor(role: string) {
    super(`Unauthorized role "${role}": ADMIN or SETTLEMENT_MANAGER required.`);
    this.name = 'SettlementRecoveryAuthorizationError';
  }
}

/**
 * Partial settlement recovery for interrupted bond transfers (#441).
 *
 * Ensures multi-leg bond transfers (e.g. debit seller position -> credit buyer
 * position -> settle USDC escrow) never leave half-applied financial state:
 * - On mid-flight failure, already-committed legs are compensated in reverse
 *   (LIFO) order so conservation of bond supply & escrow invariants hold.
 * - Retrying recovery is idempotent: already-compensated legs are not re-run.
 */
export class PartialSettlementRecoveryService {
  private readonly sessions = new Map<string, PartialSettlementSession>();

  async executeOrRecover(params: {
    settlementId: string;
    bondId: string;
    amount: string;
    actorRole: 'ADMIN' | 'SETTLEMENT_MANAGER' | 'INVESTOR';
    legs: BondTransferStep[];
  }): Promise<PartialSettlementSession> {
    if (params.actorRole !== 'ADMIN' && params.actorRole !== 'SETTLEMENT_MANAGER') {
      throw new SettlementRecoveryAuthorizationError(params.actorRole);
    }

    const existing = this.sessions.get(params.settlementId);
    if (existing && existing.status === 'COMPLETED') {
      return existing;
    }

    const session: PartialSettlementSession = existing ?? {
      settlementId: params.settlementId,
      bondId: params.bondId,
      amount: params.amount,
      actorRole: params.actorRole,
      committedLegs: [],
      rolledBackLegs: [],
      status: 'PARTIAL_FAILURE',
      attempts: 0,
    };
    session.attempts += 1;

    const executedThisRun: BondTransferStep[] = [];
    try {
      for (const leg of params.legs) {
        if (session.committedLegs.includes(leg.legId)) {
          continue;
        }
        await leg.execute();
        session.committedLegs.push(leg.legId);
        executedThisRun.push(leg);
      }
      session.status = 'COMPLETED';
      session.lastError = undefined;
      this.sessions.set(session.settlementId, session);
      return session;
    } catch (err) {
      session.lastError = err instanceof Error ? err.message : String(err);
      // Compensate committed legs in reverse order (LIFO)
      const toCompensate = [...executedThisRun].reverse();
      for (const leg of toCompensate) {
        if (!session.rolledBackLegs.includes(leg.legId)) {
          await leg.compensate();
          session.rolledBackLegs.push(leg.legId);
        }
      }
      session.committedLegs = session.committedLegs.filter(
        (id) => !session.rolledBackLegs.includes(id),
      );
      session.status = 'RECOVERED_ROLLED_BACK';
      this.sessions.set(session.settlementId, session);
      return session;
    }
  }

  getSession(settlementId: string): PartialSettlementSession | undefined {
    return this.sessions.get(settlementId);
  }
}
