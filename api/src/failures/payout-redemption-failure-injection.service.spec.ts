import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PayoutRedemptionFailureInjectionService } from './payout-redemption-failure-injection.service';
import { PartialFailureService } from './partial-failure.service';
import { FailureMode } from './failure-injection.interface';

describe('PayoutRedemptionFailureInjectionService (#474)', () => {
  let service: PayoutRedemptionFailureInjectionService;
  let mockPartialFailureService: {
    record: jest.Mock;
    resolve: jest.Mock;
  };

  beforeEach(async () => {
    mockPartialFailureService = {
      record: jest.fn().mockReturnValue({ id: 'pf_mock_123', status: 'open' }),
      resolve: jest.fn().mockReturnValue({ id: 'pf_mock_123', status: 'resolved' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutRedemptionFailureInjectionService,
        { provide: PartialFailureService, useValue: mockPartialFailureService },
      ],
    }).compile();

    service = module.get<PayoutRedemptionFailureInjectionService>(PayoutRedemptionFailureInjectionService);
    service.resetMockState();
  });

  describe('Rule Registry & Lifecycle', () => {
    it('registers, filters, and consumes an injection rule', () => {
      const rule = service.registerRule(
        {
          flowType: 'PAYOUT',
          failureMode: FailureMode.TRANSIENT_RPC_TIMEOUT,
          bondId: 1,
          count: 2,
          description: 'Simulate transient RPC drops during coupon distribution',
        },
        'GADMINOPERATOR123',
      );

      expect(rule.id).toBeDefined();
      expect(rule.isActive).toBe(true);
      expect(rule.remainingInjections).toBe(2);

      const rules = service.listRules('PAYOUT');
      expect(rules).toHaveLength(1);
      expect(rules[0].failureMode).toBe(FailureMode.TRANSIENT_RPC_TIMEOUT);

      const redemptionRules = service.listRules('REDEMPTION');
      expect(redemptionRules).toHaveLength(0);

      service.removeRule(rule.id);
      expect(service.listRules()).toHaveLength(0);
    });

    it('rejects rule registration without valid operator or description', () => {
      expect(() => {
        service.registerRule(
          {
            flowType: 'PAYOUT',
            failureMode: FailureMode.TRANSIENT_RPC_TIMEOUT,
            description: 'ok',
          },
          '',
        );
      }).toThrow(BadRequestException);

      expect(() => {
        service.registerRule(
          {
            flowType: 'PAYOUT',
            failureMode: FailureMode.TRANSIENT_RPC_TIMEOUT,
            description: '',
          },
          'GADMIN',
        );
      }).toThrow(BadRequestException);
    });
  });

  describe('Normal Path: Payout and Redemption Execution', () => {
    it('executes normal payout cleanly and preserves financial invariants', async () => {
      const result = await service.simulatePayoutFlow({
        bondId: 1,
        amount: 50_000n,
        recipientAddress: 'GAINVESTOR1',
        callerRole: 'maintainer',
        idempotencyKey: 'idemp_payout_1',
      });

      expect(result.injected).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.recovered).toBe(true);
      expect(result.recoveryMethod).toBe('NORMAL_EXECUTION');
      expect(result.transactionHash).toBeDefined();
      expect(result.invariantsPreserved).toBe(true);

      // Verify invariant values
      expect(result.postInvariants.isConserved).toBe(true);
      expect(BigInt(result.postInvariants.claimedCredits)).toBe(250_000n);
      expect(BigInt(result.postInvariants.undistributedCredits)).toBe(750_000n);
    });

    it('executes normal redemption cleanly and preserves balance conservation', async () => {
      const result = await service.simulateRedemptionFlow({
        bondId: 1,
        amount: 1_000n,
        holderAddress: 'GAINVESTOR1',
        idempotencyKey: 'idemp_redemption_1',
      });

      expect(result.injected).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.recovered).toBe(true);
      expect(result.recoveryMethod).toBe('NORMAL_EXECUTION');
      expect(result.transactionHash).toBeDefined();
      expect(result.invariantsPreserved).toBe(true);

      // Verify supply deducted and pool balance decremented
      expect(BigInt(result.postInvariants.tokenSupply)).toBe(9_000n);
      expect(BigInt(result.postInvariants.redemptionPoolBalance)).toBe(4_500_000n); // 5000000 - 1000*500
    });
  });

  describe('Failure & Retry Paths: Payout Flow', () => {
    it('handles TRANSIENT_RPC_TIMEOUT via partial failure dashboard recording and retry reconciliation', async () => {
      service.registerRule(
        {
          flowType: 'PAYOUT',
          failureMode: FailureMode.TRANSIENT_RPC_TIMEOUT,
          bondId: 1,
          description: 'Test timeout on payout',
        },
        'GADMIN',
      );

      const result = await service.simulatePayoutFlow({
        bondId: 1,
        amount: 30_000n,
        recipientAddress: 'GAINVESTOR1',
        callerRole: 'maintainer',
        idempotencyKey: 'idemp_timeout_payout',
      });

      expect(result.injected).toBe(true);
      expect(result.failureMode).toBe(FailureMode.TRANSIENT_RPC_TIMEOUT);
      expect(result.attempts).toBe(2);
      expect(result.recovered).toBe(true);
      expect(result.recoveryMethod).toBe('LEDGER_STATUS_POLL_AND_RETRY');
      expect(mockPartialFailureService.record).toHaveBeenCalledWith(
        expect.objectContaining({ operationType: 'payout.distribution' }),
      );
      expect(mockPartialFailureService.resolve).toHaveBeenCalled();
      expect(result.invariantsPreserved).toBe(true);
    });

    it('handles PRE_COMMIT_NETWORK_RESET with backoff retry', async () => {
      service.registerRule(
        {
          flowType: 'PAYOUT',
          failureMode: FailureMode.PRE_COMMIT_NETWORK_RESET,
          description: 'Network reset test',
        },
        'GADMIN',
      );

      const result = await service.simulatePayoutFlow({
        bondId: 1,
        amount: 20_000n,
        recipientAddress: 'GAINVESTOR2',
        callerRole: 'issuer',
        idempotencyKey: 'idemp_net_reset',
      });

      expect(result.injected).toBe(true);
      expect(result.failureMode).toBe(FailureMode.PRE_COMMIT_NETWORK_RESET);
      expect(result.attempts).toBe(2);
      expect(result.recoveryMethod).toBe('EXPONENTIAL_BACKOFF_RETRY');
      expect(result.invariantsPreserved).toBe(true);
    });

    it('handles CORRUPTED_NONCE with sequence resync', async () => {
      service.registerRule(
        {
          flowType: 'PAYOUT',
          failureMode: FailureMode.CORRUPTED_NONCE,
          description: 'Nonce error test',
        },
        'GADMIN',
      );

      const result = await service.simulatePayoutFlow({
        bondId: 1,
        amount: 15_000n,
        recipientAddress: 'GAINVESTOR1',
        callerRole: 'maintainer',
        idempotencyKey: 'idemp_nonce_test',
      });

      expect(result.injected).toBe(true);
      expect(result.recoveryMethod).toBe('NONCE_RESYNC_RETRY');
      expect(result.recovered).toBe(true);
      expect(result.invariantsPreserved).toBe(true);
    });
  });

  describe('Failure & Safeguard Paths: Redemption Flow', () => {
    it('safeguards financial invariants when redemption pool is UNDERFUNDED', async () => {
      service.registerRule(
        {
          flowType: 'REDEMPTION',
          failureMode: FailureMode.UNDERFUNDED_REDEMPTION_POOL,
          bondId: 1,
          description: 'Test underfunded pool invariant',
        },
        'GADMIN',
      );

      const result = await service.simulateRedemptionFlow({
        bondId: 1,
        amount: 2_000n,
        holderAddress: 'GAINVESTOR1',
        idempotencyKey: 'idemp_underfunded_1',
      });

      expect(result.injected).toBe(true);
      expect(result.failureMode).toBe(FailureMode.UNDERFUNDED_REDEMPTION_POOL);
      expect(result.recovered).toBe(false);
      expect(result.recoveryMethod).toBe('REJECTED_ZERO_STATE_MUTATION');
      expect(mockPartialFailureService.record).toHaveBeenCalledWith(
        expect.objectContaining({ operationType: 'redemption.settlement', severity: 'critical' }),
      );

      // Financial invariant check: token supply and pool balance must be completely unchanged
      expect(result.invariantsPreserved).toBe(true);
      expect(result.postInvariants.tokenSupply).toBe(result.preInvariants.tokenSupply);
      expect(result.postInvariants.redemptionPoolBalance).toBe(result.preInvariants.redemptionPoolBalance);
    });

    it('rejects redemption exceeding holder token balance', async () => {
      await expect(
        service.simulateRedemptionFlow({
          bondId: 1,
          amount: 50_000n, // exceeds 4000
          holderAddress: 'GAINVESTOR1',
          idempotencyKey: 'idemp_overspend',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Authorization & Compliance Paths', () => {
    it('rejects unauthorized caller role during payout simulation', async () => {
      await expect(
        service.simulatePayoutFlow({
          bondId: 1,
          amount: 10_000n,
          recipientAddress: 'GAINVESTOR1',
          callerRole: 'investor', // investors cannot distribute payouts
          idempotencyKey: 'idemp_unauth_caller',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('halts execution when UNAUTHORIZED_CALLER failure is injected for compliance screening', async () => {
      service.registerRule(
        {
          flowType: 'PAYOUT',
          failureMode: FailureMode.UNAUTHORIZED_CALLER,
          bondId: 1,
          description: 'Sanctions freeze simulation',
        },
        'GADMIN',
      );

      await expect(
        service.simulatePayoutFlow({
          bondId: 1,
          amount: 10_000n,
          recipientAddress: 'GAINVESTOR1',
          callerRole: 'maintainer',
          idempotencyKey: 'idemp_sanctions_test',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Idempotency & Replay Protection', () => {
    it('returns cached result on concurrent duplicate request without double credit debit', async () => {
      const key = 'idemp_concurrent_key_999';

      const first = await service.simulatePayoutFlow({
        bondId: 1,
        amount: 25_000n,
        recipientAddress: 'GAINVESTOR1',
        callerRole: 'maintainer',
        idempotencyKey: key,
      });

      expect(first.recovered).toBe(true);
      const claimedAfterFirst = service.getFinancialInvariants().claimedCredits;

      // Second identical call
      const second = await service.simulatePayoutFlow({
        bondId: 1,
        amount: 25_000n,
        recipientAddress: 'GAINVESTOR1',
        callerRole: 'maintainer',
        idempotencyKey: key,
      });

      expect(second.recoveryMethod).toBe('IDEMPOTENT_CACHE_HIT');
      expect(second.transactionHash).toBe(first.transactionHash);

      // Verify no double-spending of credits occurred
      const claimedAfterSecond = service.getFinancialInvariants().claimedCredits;
      expect(claimedAfterSecond).toBe(claimedAfterFirst);
      expect(second.invariantsPreserved).toBe(true);
    });
  });
});
