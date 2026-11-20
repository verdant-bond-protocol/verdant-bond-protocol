import { Injectable, Logger } from '@nestjs/common';

export enum BondState {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEFAULTED = 'DEFAULTED',
  RESTRUCTURED = 'RESTRUCTURED',
  MATURED = 'MATURED',
  CANCELLED = 'CANCELLED',
  LIQUIDATED = 'LIQUIDATED',
}

export enum BondEvent {
  PUBLISH = 'PUBLISH',
  CANCEL = 'CANCEL',
  FUND = 'FUND',
  SUSPEND = 'SUSPEND',
  RESUME = 'RESUME',
  MISS_PAYMENT = 'MISS_PAYMENT',
  CURE_DEFAULT = 'CURE_DEFAULT',
  RESTRUCTURE = 'RESTRUCTURE',
  LIQUIDATE = 'LIQUIDATE',
  REPAY_FULL = 'REPAY_FULL',
}

export class InvalidStateTransitionException extends Error {
  constructor(
    public readonly fromState: string,
    public readonly event: string,
    public readonly allowedEvents: string[],
    public readonly isTerminal: boolean,
  ) {
    const terminalNote = isTerminal ? ' State is terminal.' : '';
    const allowedMsg = allowedEvents.length
      ? ` Allowed events: [${allowedEvents.join(', ')}].`
      : ' No outgoing transitions permitted.';
    super(
      `Invalid state transition from ${fromState} via event ${event}.${terminalNote}${allowedMsg}`,
    );
    this.name = 'InvalidStateTransitionException';
  }
}

export interface TransitionRecord<S = string, E = string> {
  timestamp: Date;
  fromState: S;
  toState: S;
  event: E;
  actor?: string;
  reason?: string;
}

@Injectable()
export class BondStateMachine {
  private readonly logger = new Logger(BondStateMachine.name);

  private readonly transitions: Record<BondState, Partial<Record<BondEvent, BondState>>> = {
    [BondState.DRAFT]: {
      [BondEvent.PUBLISH]: BondState.ISSUED,
      [BondEvent.CANCEL]: BondState.CANCELLED,
    },
    [BondState.ISSUED]: {
      [BondEvent.FUND]: BondState.ACTIVE,
      [BondEvent.CANCEL]: BondState.CANCELLED,
    },
    [BondState.ACTIVE]: {
      [BondEvent.SUSPEND]: BondState.SUSPENDED,
      [BondEvent.MISS_PAYMENT]: BondState.DEFAULTED,
      [BondEvent.REPAY_FULL]: BondState.MATURED,
    },
    [BondState.SUSPENDED]: {
      // Recovery path from suspended state
      [BondEvent.RESUME]: BondState.ACTIVE,
      [BondEvent.MISS_PAYMENT]: BondState.DEFAULTED,
    },
    [BondState.DEFAULTED]: {
      // Recovery paths from default
      [BondEvent.CURE_DEFAULT]: BondState.ACTIVE,
      [BondEvent.RESTRUCTURE]: BondState.RESTRUCTURED,
      // Terminal liquidation if default cannot be cured
      [BondEvent.LIQUIDATE]: BondState.LIQUIDATED,
    },
    [BondState.RESTRUCTURED]: {
      // Restructured bond resumes operations or matures
      [BondEvent.RESUME]: BondState.ACTIVE,
      [BondEvent.REPAY_FULL]: BondState.MATURED,
      [BondEvent.MISS_PAYMENT]: BondState.DEFAULTED,
    },
    // Terminal States: Zero outgoing transitions
    [BondState.MATURED]: {},
    [BondState.CANCELLED]: {},
    [BondState.LIQUIDATED]: {},
  };

  private readonly terminalStates = new Set<BondState>([
    BondState.MATURED,
    BondState.CANCELLED,
    BondState.LIQUIDATED,
  ]);

  private readonly history: TransitionRecord<BondState, BondEvent>[] = [];

  transition(
    currentState: BondState,
    event: BondEvent,
    context?: { actor?: string; reason?: string },
  ): BondState {
    const allowedMap = this.transitions[currentState] || {};
    const nextState = allowedMap[event];

    if (!nextState) {
      const allowedEvents = Object.keys(allowedMap);
      const isTerminal = this.isTerminal(currentState);
      const error = new InvalidStateTransitionException(
        currentState,
        event,
        allowedEvents,
        isTerminal,
      );
      this.logger.error(error.message);
      throw error;
    }

    const record: TransitionRecord<BondState, BondEvent> = {
      timestamp: new Date(),
      fromState: currentState,
      toState: nextState,
      event,
      actor: context?.actor,
      reason: context?.reason,
    };
    this.history.push(record);

    this.logger.log(`Bond transitioned from ${currentState} to ${nextState} via ${event}`);
    return nextState;
  }

  canTransition(currentState: BondState, event: BondEvent): boolean {
    const allowedMap = this.transitions[currentState] || {};
    return Boolean(allowedMap[event]);
  }

  isTerminal(state: BondState): boolean {
    return this.terminalStates.has(state);
  }

  getAllowedEvents(state: BondState): BondEvent[] {
    return Object.keys(this.transitions[state] || {}) as BondEvent[];
  }

  getHistory(): TransitionRecord<BondState, BondEvent>[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history.length = 0;
  }
}

// ============================================================================
// Carbon Credit Coupon Lifecycle State Machine
// ============================================================================
export enum CouponState {
  SCHEDULED = 'SCHEDULED',
  ORACLE_VERIFYING = 'ORACLE_VERIFYING',
  VERIFIED = 'VERIFIED',
  DISTRIBUTING = 'DISTRIBUTING',
  DISTRIBUTED = 'DISTRIBUTED',
  CHALLENGED = 'CHALLENGED',
  RECONCILED = 'RECONCILED',
  FAILED = 'FAILED',
}

export enum CouponEvent {
  TRIGGER_VERIFICATION = 'TRIGGER_VERIFICATION',
  CONFIRM_ORACLE = 'CONFIRM_ORACLE',
  START_DISTRIBUTION = 'START_DISTRIBUTION',
  COMPLETE_DISTRIBUTION = 'COMPLETE_DISTRIBUTION',
  CHALLENGE = 'CHALLENGE',
  RESOLVE_CHALLENGE = 'RESOLVE_CHALLENGE',
  FAIL = 'FAIL',
  RETRY = 'RETRY',
}

@Injectable()
export class CouponStateMachine {
  private readonly logger = new Logger(CouponStateMachine.name);

  private readonly transitions: Record<CouponState, Partial<Record<CouponEvent, CouponState>>> = {
    [CouponState.SCHEDULED]: {
      [CouponEvent.TRIGGER_VERIFICATION]: CouponState.ORACLE_VERIFYING,
      [CouponEvent.FAIL]: CouponState.FAILED,
    },
    [CouponState.ORACLE_VERIFYING]: {
      [CouponEvent.CONFIRM_ORACLE]: CouponState.VERIFIED,
      [CouponEvent.CHALLENGE]: CouponState.CHALLENGED,
      [CouponEvent.FAIL]: CouponState.FAILED,
    },
    [CouponState.VERIFIED]: {
      [CouponEvent.START_DISTRIBUTION]: CouponState.DISTRIBUTING,
      [CouponEvent.CHALLENGE]: CouponState.CHALLENGED,
    },
    [CouponState.DISTRIBUTING]: {
      [CouponEvent.COMPLETE_DISTRIBUTION]: CouponState.DISTRIBUTED,
      [CouponEvent.FAIL]: CouponState.FAILED,
    },
    [CouponState.CHALLENGED]: {
      // Recovery from oracle challenge
      [CouponEvent.RESOLVE_CHALLENGE]: CouponState.RECONCILED,
      [CouponEvent.FAIL]: CouponState.FAILED,
    },
    [CouponState.RECONCILED]: {
      // Resumes distribution after reconciliation
      [CouponEvent.START_DISTRIBUTION]: CouponState.DISTRIBUTING,
    },
    [CouponState.FAILED]: {
      // Recovery retry
      [CouponEvent.RETRY]: CouponState.SCHEDULED,
    },
    // Terminal state
    [CouponState.DISTRIBUTED]: {},
  };

  private readonly terminalStates = new Set<CouponState>([CouponState.DISTRIBUTED]);

  transition(currentState: CouponState, event: CouponEvent): CouponState {
    const allowed = this.transitions[currentState] || {};
    const next = allowed[event];
    if (!next) {
      throw new InvalidStateTransitionException(
        currentState,
        event,
        Object.keys(allowed),
        this.terminalStates.has(currentState),
      );
    }
    return next;
  }

  isTerminal(state: CouponState): boolean {
    return this.terminalStates.has(state);
  }
}

// ============================================================================
// Secondary-Market Settlement Lifecycle State Machine
// ============================================================================
export enum SettlementState {
  PROPOSED = 'PROPOSED',
  ESCROW_LOCKED = 'ESCROW_LOCKED',
  SETTLING = 'SETTLING',
  SETTLED = 'SETTLED',
  DISPUTED = 'DISPUTED',
  REVERSED = 'REVERSED',
}

export enum SettlementEvent {
  LOCK_ESCROW = 'LOCK_ESCROW',
  CANCEL_ORDER = 'CANCEL_ORDER',
  EXECUTE_SETTLEMENT = 'EXECUTE_SETTLEMENT',
  CONFIRM_RECEIPT = 'CONFIRM_RECEIPT',
  DISPUTE = 'DISPUTE',
  RESOLVE_ROLLBACK = 'RESOLVE_ROLLBACK',
}

@Injectable()
export class SettlementStateMachine {
  private readonly logger = new Logger(SettlementStateMachine.name);

  private readonly transitions: Record<SettlementState, Partial<Record<SettlementEvent, SettlementState>>> = {
    [SettlementState.PROPOSED]: {
      [SettlementEvent.LOCK_ESCROW]: SettlementState.ESCROW_LOCKED,
      [SettlementEvent.CANCEL_ORDER]: SettlementState.REVERSED,
    },
    [SettlementState.ESCROW_LOCKED]: {
      [SettlementEvent.EXECUTE_SETTLEMENT]: SettlementState.SETTLING,
      [SettlementEvent.CANCEL_ORDER]: SettlementState.REVERSED,
    },
    [SettlementState.SETTLING]: {
      [SettlementEvent.CONFIRM_RECEIPT]: SettlementState.SETTLED,
      [SettlementEvent.DISPUTE]: SettlementState.DISPUTED,
    },
    [SettlementState.DISPUTED]: {
      // Recovery transition: safe rollback releasing escrowed bond & funds
      [SettlementEvent.RESOLVE_ROLLBACK]: SettlementState.REVERSED,
      [SettlementEvent.CONFIRM_RECEIPT]: SettlementState.SETTLED,
    },
    // Terminal States
    [SettlementState.SETTLED]: {},
    [SettlementState.REVERSED]: {},
  };

  private readonly terminalStates = new Set<SettlementState>([
    SettlementState.SETTLED,
    SettlementState.REVERSED,
  ]);

  transition(currentState: SettlementState, event: SettlementEvent): SettlementState {
    const allowed = this.transitions[currentState] || {};
    const next = allowed[event];
    if (!next) {
      throw new InvalidStateTransitionException(
        currentState,
        event,
        Object.keys(allowed),
        this.terminalStates.has(currentState),
      );
    }
    return next;
  }

  isTerminal(state: SettlementState): boolean {
    return this.terminalStates.has(state);
  }
}
