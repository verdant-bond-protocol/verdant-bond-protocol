import {
  BondStateMachine,
  BondState,
  BondEvent,
  CouponStateMachine,
  CouponState,
  CouponEvent,
  SettlementStateMachine,
  SettlementState,
  SettlementEvent,
  InvalidStateTransitionException,
} from './bond.state-machine';

describe('Formal Lifecycle State-Machine (#358)', () => {
  let bondMachine: BondStateMachine;
  let couponMachine: CouponStateMachine;
  let settlementMachine: SettlementStateMachine;

  beforeEach(() => {
    bondMachine = new BondStateMachine();
    couponMachine = new CouponStateMachine();
    settlementMachine = new SettlementStateMachine();
  });

  describe('BondStateMachine: Happy Path Lifecycle', () => {
    it('progresses through DRAFT -> ISSUED -> ACTIVE -> MATURED', () => {
      let state = BondState.DRAFT;

      state = bondMachine.transition(state, BondEvent.PUBLISH, { actor: 'issuer-1' });
      expect(state).toBe(BondState.ISSUED);

      state = bondMachine.transition(state, BondEvent.FUND, { actor: 'investor-pool' });
      expect(state).toBe(BondState.ACTIVE);

      state = bondMachine.transition(state, BondEvent.REPAY_FULL, { reason: 'Final coupon and principal returned' });
      expect(state).toBe(BondState.MATURED);

      expect(bondMachine.isTerminal(state)).toBe(true);
      expect(bondMachine.getHistory()).toHaveLength(3);
    });
  });

  describe('BondStateMachine: Terminal Transitions', () => {
    it('transitions DRAFT -> CANCELLED as a terminal state', () => {
      const state = bondMachine.transition(BondState.DRAFT, BondEvent.CANCEL);
      expect(state).toBe(BondState.CANCELLED);
      expect(bondMachine.isTerminal(state)).toBe(true);

      // No event permitted from terminal CANCELLED state
      expect(() => {
        bondMachine.transition(state, BondEvent.PUBLISH);
      }).toThrow(InvalidStateTransitionException);
    });

    it('transitions ISSUED -> CANCELLED when auction fails minimum threshold', () => {
      const state = bondMachine.transition(BondState.ISSUED, BondEvent.CANCEL);
      expect(state).toBe(BondState.CANCELLED);
      expect(bondMachine.isTerminal(state)).toBe(true);
    });

    it('transitions DEFAULTED -> LIQUIDATED when default is uncured', () => {
      const state = bondMachine.transition(BondState.DEFAULTED, BondEvent.LIQUIDATE);
      expect(state).toBe(BondState.LIQUIDATED);
      expect(bondMachine.isTerminal(state)).toBe(true);

      expect(() => {
        bondMachine.transition(state, BondEvent.CURE_DEFAULT);
      }).toThrow(InvalidStateTransitionException);
    });

    it('rejects all events from MATURED terminal state', () => {
      for (const event of Object.values(BondEvent)) {
        expect(() => {
          bondMachine.transition(BondState.MATURED, event);
        }).toThrow(InvalidStateTransitionException);
      }
    });
  });

  describe('BondStateMachine: Recovery Transitions', () => {
    it('recovers from SUSPENDED back to ACTIVE via RESUME', () => {
      // ACTIVE -> SUSPENDED (e.g. oracle halt or audit hold)
      let state = bondMachine.transition(BondState.ACTIVE, BondEvent.SUSPEND, { reason: 'Oracle circuit breaker tripped' });
      expect(state).toBe(BondState.SUSPENDED);

      // Recovery: RESUME
      state = bondMachine.transition(state, BondEvent.RESUME, { reason: 'Oracle consensus restored' });
      expect(state).toBe(BondState.ACTIVE);
    });

    it('recovers from DEFAULTED back to ACTIVE via CURE_DEFAULT', () => {
      // ACTIVE -> DEFAULTED
      let state = bondMachine.transition(BondState.ACTIVE, BondEvent.MISS_PAYMENT);
      expect(state).toBe(BondState.DEFAULTED);

      // Recovery: Issuer cures default during grace period
      state = bondMachine.transition(state, BondEvent.CURE_DEFAULT, { reason: 'Late coupon paid with penalty' });
      expect(state).toBe(BondState.ACTIVE);
    });

    it('recovers from DEFAULTED through RESTRUCTURE to RESTRUCTURED and back to ACTIVE', () => {
      // ACTIVE -> DEFAULTED
      let state = bondMachine.transition(BondState.ACTIVE, BondEvent.MISS_PAYMENT);
      expect(state).toBe(BondState.DEFAULTED);

      // Recovery: Bondholder vote approves restructuring
      state = bondMachine.transition(state, BondEvent.RESTRUCTURE, { reason: 'Governance vote 32 approved' });
      expect(state).toBe(BondState.RESTRUCTURED);

      // Resumes operations under restructured covenant terms
      state = bondMachine.transition(state, BondEvent.RESUME);
      expect(state).toBe(BondState.ACTIVE);
    });
  });

  describe('BondStateMachine: Deterministic Error Rejection', () => {
    it('throws InvalidStateTransitionException with diagnostic details for invalid transitions', () => {
      try {
        bondMachine.transition(BondState.DRAFT, BondEvent.REPAY_FULL);
        fail('Expected InvalidStateTransitionException');
      } catch (e: any) {
        expect(e).toBeInstanceOf(InvalidStateTransitionException);
        expect(e.fromState).toBe(BondState.DRAFT);
        expect(e.event).toBe(BondEvent.REPAY_FULL);
        expect(e.allowedEvents).toContain(BondEvent.PUBLISH);
        expect(e.allowedEvents).toContain(BondEvent.CANCEL);
        expect(e.isTerminal).toBe(false);
      }
    });

    it('flags isTerminal: true when attempting to transition from terminal state', () => {
      try {
        bondMachine.transition(BondState.LIQUIDATED, BondEvent.RESUME);
        fail('Expected InvalidStateTransitionException');
      } catch (e: any) {
        expect(e).toBeInstanceOf(InvalidStateTransitionException);
        expect(e.fromState).toBe(BondState.LIQUIDATED);
        expect(e.isTerminal).toBe(true);
        expect(e.allowedEvents).toHaveLength(0);
      }
    });
  });

  describe('CouponStateMachine: Carbon Credit Coupon Lifecycle', () => {
    it('progresses through SCHEDULED -> ORACLE_VERIFYING -> VERIFIED -> DISTRIBUTING -> DISTRIBUTED', () => {
      let state = CouponState.SCHEDULED;

      state = couponMachine.transition(state, CouponEvent.TRIGGER_VERIFICATION);
      expect(state).toBe(CouponState.ORACLE_VERIFYING);

      state = couponMachine.transition(state, CouponEvent.CONFIRM_ORACLE);
      expect(state).toBe(CouponState.VERIFIED);

      state = couponMachine.transition(state, CouponEvent.START_DISTRIBUTION);
      expect(state).toBe(CouponState.DISTRIBUTING);

      state = couponMachine.transition(state, CouponEvent.COMPLETE_DISTRIBUTION);
      expect(state).toBe(CouponState.DISTRIBUTED);
      expect(couponMachine.isTerminal(state)).toBe(true);
    });

    it('recovers from CHALLENGED through RESOLVE_CHALLENGE -> RECONCILED -> DISTRIBUTING', () => {
      // ORACLE_VERIFYING -> CHALLENGED
      let state = couponMachine.transition(CouponState.ORACLE_VERIFYING, CouponEvent.CHALLENGE);
      expect(state).toBe(CouponState.CHALLENGED);

      // Recovery: Challenge resolved via oracle multi-source reconciliation
      state = couponMachine.transition(state, CouponEvent.RESOLVE_CHALLENGE);
      expect(state).toBe(CouponState.RECONCILED);

      // Resumes distribution
      state = couponMachine.transition(state, CouponEvent.START_DISTRIBUTION);
      expect(state).toBe(CouponState.DISTRIBUTING);
    });

    it('recovers from FAILED via RETRY back to SCHEDULED', () => {
      const state = couponMachine.transition(CouponState.FAILED, CouponEvent.RETRY);
      expect(state).toBe(CouponState.SCHEDULED);
    });
  });

  describe('SettlementStateMachine: Secondary-Market Settlement', () => {
    it('progresses through PROPOSED -> ESCROW_LOCKED -> SETTLING -> SETTLED', () => {
      let state = SettlementState.PROPOSED;

      state = settlementMachine.transition(state, SettlementEvent.LOCK_ESCROW);
      expect(state).toBe(SettlementState.ESCROW_LOCKED);

      state = settlementMachine.transition(state, SettlementEvent.EXECUTE_SETTLEMENT);
      expect(state).toBe(SettlementState.SETTLING);

      state = settlementMachine.transition(state, SettlementEvent.CONFIRM_RECEIPT);
      expect(state).toBe(SettlementState.SETTLED);
      expect(settlementMachine.isTerminal(state)).toBe(true);
    });

    it('recovers from DISPUTED via RESOLVE_ROLLBACK to REVERSED terminal state', () => {
      // SETTLING -> DISPUTED
      let state = settlementMachine.transition(SettlementState.SETTLING, SettlementEvent.DISPUTE);
      expect(state).toBe(SettlementState.DISPUTED);

      // Recovery rollback: release escrow and return assets cleanly
      state = settlementMachine.transition(state, SettlementEvent.RESOLVE_ROLLBACK);
      expect(state).toBe(SettlementState.REVERSED);
      expect(settlementMachine.isTerminal(state)).toBe(true);
    });
  });
});
