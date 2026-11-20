import {
  CounterpartyRiskService,
  CovenantBreachService,
  SettlementDisputeService,
  SettlementDispute,
} from './investor-workflows.service';

describe('investor workflow services', () => {
  describe('CounterpartyRiskService', () => {
    const service = new CounterpartyRiskService();

    it('covers unknown, low, medium, high and manual override buckets', () => {
      expect(service.assess({ counterpartyId: 'issuer-1' }).bucket).toBe('unknown');
      expect(service.assess({ counterpartyId: 'issuer-1', kycVerified: true }).bucket).toBe('low');
      expect(service.assess({ counterpartyId: 'issuer-1', kycVerified: false }).bucket).toBe('medium');
      expect(service.assess({ counterpartyId: 'issuer-1', covenantBreaches: 3, rejectedSettlements: 1 }).bucket).toBe('high');
      expect(service.assess({ counterpartyId: 'issuer-1', manualOverride: 'high', overrideReason: 'sanctions review' }).bucket).toBe('high');
    });

    it('does not expose raw thresholds in the user-facing summary', () => {
      const assessment = service.assess({ counterpartyId: 'issuer-1', covenantBreaches: 2 });
      expect(assessment.userSummary).toEqual(expect.objectContaining({ visibility: 'public', bucket: 'medium' }));
      expect(JSON.stringify(assessment.userSummary)).not.toContain('score');
      expect(assessment.maintainerDetail.signals.score).toBe(40);
    });
  });

  describe('SettlementDisputeService', () => {
    const service = new SettlementDisputeService();
    const disputeInput = {
      id: 'disp-1',
      settlementId: 'settlement-1',
      openedBy: 'investor-1',
      evidence: [
        { id: 'ev-public', uri: 'ipfs://public', visibility: 'public' as const, description: 'receipt' },
        { id: 'ev-private', uri: 'ipfs://private', visibility: 'private' as const, description: 'bank trace' },
      ],
      publicNotes: ['public note'],
      privateNotes: ['maintainer note'],
    };

    it('opens, investigates, resolves, rejects and reopens according to policy', () => {
      const opened = service.open([], disputeInput, 'investor-1', '2026-01-01T00:00:00.000Z');
      const investigating = service.transition(opened, 'investigating', 'maintainer', 'review evidence', '2026-01-02T00:00:00.000Z');
      const resolved = service.transition(investigating, 'resolved', 'maintainer', 'issuer paid', '2026-01-03T00:00:00.000Z');
      const reopened = service.transition(resolved, 'investigating', 'maintainer', 'new evidence', '2026-01-04T00:00:00.000Z');
      const rejected = service.transition(reopened, 'rejected', 'maintainer', 'unsupported claim', '2026-01-05T00:00:00.000Z');

      expect(rejected.state).toBe('rejected');
      expect(rejected.audit.map((entry) => entry.action)).toEqual(['open', 'investigating', 'resolved', 'investigating', 'rejected']);
    });

    it('rejects duplicate active disputes and hides private evidence from users', () => {
      const active = service.open([], disputeInput, 'investor-1', '2026-01-01T00:00:00.000Z');
      expect(() => service.open([active], { ...disputeInput, id: 'disp-2' }, 'investor-2', '2026-01-02T00:00:00.000Z')).toThrow(/Active dispute/);
      expect(service.visibleEvidence(active, 'public').map((item) => item.id)).toEqual(['ev-public']);
      expect(service.visibleEvidence(active, 'maintainer').map((item) => item.id)).toEqual(['ev-public', 'ev-private']);
    });

    it('rejects unsupported transitions', () => {
      const active: SettlementDispute = service.open([], disputeInput, 'investor-1', '2026-01-01T00:00:00.000Z');
      expect(() => service.transition(active, 'open', 'maintainer', 'rewind', '2026-01-02T00:00:00.000Z')).toThrow(/Cannot transition/);
    });
  });

  describe('CovenantBreachService', () => {
    const service = new CovenantBreachService();

    it('detects clear and breached covenant states deterministically', () => {
      expect(service.evaluate({ bondId: 'bond-1' }).state).toBe('clear');

      const breached = service.evaluate({
        bondId: 'bond-1',
        reportsLateByDays: 10,
        sustainabilityMetricValid: false,
      });
      expect(breached.state).toBe('detected');
      expect(breached.severity).toBe('high');
      expect(breached.investorStatus.nextStep).toContain('awaiting maintainer review');
      expect(breached.audit[0].actor).toBe('system');
    });

    it('audits manual investigation, remediation accepted, rejected and resolved states', () => {
      const detected = service.evaluate({ bondId: 'bond-1', repaymentDaysPastDue: 3 });
      const investigating = service.maintainerAction(detected, 'investigating', 'maintainer', 'open case', '2026-01-02T00:00:00.000Z');
      const accepted = service.maintainerAction(investigating, 'remediation_accepted', 'maintainer', 'issuer plan accepted', '2026-01-03T00:00:00.000Z');
      const rejected = service.maintainerAction(accepted, 'remediation_rejected', 'maintainer', 'plan missed deadline', '2026-01-04T00:00:00.000Z');
      const resolved = service.maintainerAction(rejected, 'resolved', 'maintainer', 'investors notified', '2026-01-05T00:00:00.000Z');

      expect(resolved.state).toBe('resolved');
      expect(resolved.audit.map((entry) => entry.action)).toEqual([
        'detected',
        'investigating',
        'remediation_accepted',
        'remediation_rejected',
        'resolved',
      ]);
    });
  });
});
