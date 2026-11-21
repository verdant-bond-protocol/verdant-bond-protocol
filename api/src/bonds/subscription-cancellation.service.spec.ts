import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  SubscriptionCancellationService,
  SubscriptionCancellationReason,
} from './subscription-cancellation.service';

describe('SubscriptionCancellationService (#639)', () => {
  let service: SubscriptionCancellationService;
  let clock: number;

  const BOND_ID = 101;
  const INVESTOR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const STRANGER = 'GSTRANGER0000000000000000000000000000000000000000000000';
  const ADMIN = 'GADMIN0000000000000000000000000000000000000000000000000';

  beforeEach(() => {
    clock = 1_700_000_000_000;
    service = new SubscriptionCancellationService();
    service.now = () => clock;
    service.registerPending(BOND_ID, INVESTOR, '5000');
  });

  describe('Normal Path', () => {
    it('cancels pending subscription, transitions state, and produces verifiable hash chain receipt', async () => {
      const receipt = await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
          idempotencyKey: 'idem-1',
          note: 'Changed investment allocation',
        },
        { address: INVESTOR, role: 'investor' },
      );

      expect(receipt.sequence).toBe(1);
      expect(receipt.bondId).toBe(BOND_ID);
      expect(receipt.investorAddress).toBe(INVESTOR);
      expect(receipt.actorAddress).toBe(INVESTOR);
      expect(receipt.actorRole).toBe('investor');
      expect(receipt.reasonCode).toBe(SubscriptionCancellationReason.INVESTOR_REQUESTED);
      expect(receipt.note).toBe('Changed investment allocation');
      expect(receipt.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.prevHash).toBe('0'.repeat(64));

      const pending = service.getPending(BOND_ID, INVESTOR);
      expect(pending?.status).toBe('CANCELLED');
      expect(service.verifyChain().valid).toBe(true);
    });

    it('chains sequential cancellations with immutable parent hash linking', async () => {
      await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
          idempotencyKey: 'idem-1',
        },
        { address: INVESTOR, role: 'investor' },
      );

      const INVESTOR_2 = 'GBBD222222222222222222222222222222222222222222222222222';
      service.registerPending(BOND_ID, INVESTOR_2, '2000');

      const receipt2 = await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR_2,
          reasonCode: SubscriptionCancellationReason.TIMEOUT_RECOVERY,
          idempotencyKey: 'idem-2',
        },
        { address: ADMIN, role: 'admin', isAdmin: true },
      );

      expect(receipt2.sequence).toBe(2);
      const list = service.listReceipts();
      expect(receipt2.prevHash).toBe(list[0].hash);
      expect(service.verifyChain().valid).toBe(true);
    });
  });

  describe('Authorization Path', () => {
    it('rejects cancellation when non-admin actor is not the subscription owner', async () => {
      await expect(
        service.cancel(
          BOND_ID,
          {
            investorAddress: INVESTOR,
            reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
            idempotencyKey: 'idem-unauth',
          },
          { address: STRANGER, role: 'investor' },
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(service.getPending(BOND_ID, INVESTOR)?.status).toBe('PENDING');
    });

    it('permits authorized admin to cancel on behalf of an investor', async () => {
      const receipt = await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.SANCTIONS_BLOCK,
          idempotencyKey: 'idem-admin',
          note: 'Compliance sanctions match',
        },
        { address: ADMIN, role: 'admin', isAdmin: true },
      );

      expect(receipt.actorRole).toBe('admin');
      expect(service.getPending(BOND_ID, INVESTOR)?.status).toBe('CANCELLED');
    });
  });

  describe('Failure & Validation Paths', () => {
    it('fails when idempotency key is missing or blank', async () => {
      await expect(
        service.cancel(
          BOND_ID,
          {
            investorAddress: INVESTOR,
            reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
            idempotencyKey: '   ',
          },
          { address: INVESTOR, role: 'investor' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('fails when note exceeds maximum length', async () => {
      await expect(
        service.cancel(
          BOND_ID,
          {
            investorAddress: INVESTOR,
            reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
            idempotencyKey: 'idem-long-note',
            note: 'X'.repeat(281),
          },
          { address: INVESTOR, role: 'investor' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('fails with 404 when subscription does not exist', async () => {
      await expect(
        service.cancel(
          BOND_ID,
          {
            investorAddress: STRANGER,
            reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
            idempotencyKey: 'idem-missing',
          },
          { address: STRANGER, role: 'investor' },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('fails with 409 when subscription is already settled', async () => {
      const pending = service.getPending(BOND_ID, INVESTOR)!;
      pending.status = 'SETTLED';

      await expect(
        service.cancel(
          BOND_ID,
          {
            investorAddress: INVESTOR,
            reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
            idempotencyKey: 'idem-settled',
          },
          { address: INVESTOR, role: 'investor' },
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('fails with 409 on second cancel attempt with a different idempotency key', async () => {
      await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
          idempotencyKey: 'idem-first',
        },
        { address: INVESTOR, role: 'investor' },
      );

      await expect(
        service.cancel(
          BOND_ID,
          {
            investorAddress: INVESTOR,
            reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
            idempotencyKey: 'idem-second',
          },
          { address: INVESTOR, role: 'investor' },
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Retry Path (Idempotency)', () => {
    it('returns original receipt on duplicate submission with matching idempotency key', async () => {
      const first = await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
          idempotencyKey: 'idem-safe-retry',
          note: 'Network glitch retry test',
        },
        { address: INVESTOR, role: 'investor' },
      );

      clock += 5000;

      const retry = await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
          idempotencyKey: 'idem-safe-retry',
          note: 'Different note ignored',
        },
        { address: INVESTOR, role: 'investor' },
      );

      expect(retry).toEqual(first);
      expect(service.listReceipts()).toHaveLength(1);
    });
  });

  describe('Audit Chain Tamper Detection', () => {
    it('detects tampering in audit chain sequence or hash', async () => {
      await service.cancel(
        BOND_ID,
        {
          investorAddress: INVESTOR,
          reasonCode: SubscriptionCancellationReason.INVESTOR_REQUESTED,
          idempotencyKey: 'idem-tamper',
        },
        { address: INVESTOR, role: 'investor' },
      );

      // Verify intact
      expect(service.verifyChain().valid).toBe(true);

      // Mutate private state
      (service as any).receipts[0].note = 'Tampered content';
      expect(service.verifyChain().valid).toBe(false);
      expect(service.verifyChain().brokenAt).toBe(1);
    });
  });
});

