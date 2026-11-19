import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CancellationReasonCode,
  CancellationRequest,
  GENESIS_HASH,
  OrderCancellationAuditService,
} from './order-cancellation-audit.service';

const OWNER = 'GOWNER';

describe('OrderCancellationAuditService (#440)', () => {
  let service: OrderCancellationAuditService;
  let clock: number;

  const request = (overrides: Partial<CancellationRequest> = {}): CancellationRequest => ({
    orderId: 1,
    orderOwner: OWNER,
    actor: { address: OWNER, role: 'owner' },
    reasonCode: CancellationReasonCode.USER_REQUESTED,
    idempotencyKey: 'key-1',
    ...overrides,
  });

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (err) {
      return (err as { getResponse(): { code?: string } }).getResponse().code;
    }
    return undefined;
  };

  beforeEach(() => {
    clock = 1_700_000_000_000;
    service = new OrderCancellationAuditService();
    service.now = () => clock;
  });

  describe('normal path', () => {
    it('records an owner cancellation with a hash-chained entry', () => {
      const entry = service.record(request());
      expect(entry).toMatchObject({
        sequence: 1,
        orderId: 1,
        actorAddress: OWNER,
        actorRole: 'owner',
        reasonCode: CancellationReasonCode.USER_REQUESTED,
        note: null,
        recordedAt: clock,
        prevHash: GENESIS_HASH,
      });
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(service.getForOrder(1)).toEqual(entry);
    });

    it('chains entries and verifies the chain', () => {
      const first = service.record(request());
      const second = service.record(
        request({
          orderId: 2,
          actor: { address: 'keeper', role: 'system' },
          reasonCode: CancellationReasonCode.EXPIRED,
          idempotencyKey: 'key-2',
        }),
      );
      expect(second.prevHash).toBe(first.hash);
      expect(service.verifyChain()).toEqual({ valid: true });
    });

    it('filters and summarises by reason code', () => {
      service.record(request());
      service.record(
        request({
          orderId: 2,
          actor: { address: 'GADMIN', role: 'admin' },
          reasonCode: CancellationReasonCode.ADMIN_HALT,
          note: 'market halted for incident',
          idempotencyKey: 'key-2',
        }),
      );
      expect(service.list({ reasonCode: CancellationReasonCode.ADMIN_HALT }).map((e) => e.orderId)).toEqual([2]);
      expect(service.list({ actorRole: 'owner' }).map((e) => e.orderId)).toEqual([1]);
      const summary = service.summary();
      expect(summary.USER_REQUESTED).toBe(1);
      expect(summary.ADMIN_HALT).toBe(1);
      expect(summary.EXPIRED).toBe(0);
    });
  });

  describe('failure paths', () => {
    it('rejects unknown reason codes', () => {
      expect(() => service.record(request({ reasonCode: 'BOGUS' as unknown as CancellationReasonCode }))).toThrow(
        BadRequestException,
      );
    });

    it('requires an idempotency key', () => {
      expect(codeOf(() => service.record(request({ idempotencyKey: '' })))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('requires a note for admin halts and compliance holds', () => {
      const admin = { address: 'GADMIN', role: 'admin' as const };
      expect(
        codeOf(() => service.record(request({ actor: admin, reasonCode: CancellationReasonCode.ADMIN_HALT }))),
      ).toBe('NOTE_REQUIRED');
      expect(
        codeOf(() =>
          service.record(request({ actor: admin, reasonCode: CancellationReasonCode.COMPLIANCE_HOLD, note: '   ' })),
        ),
      ).toBe('NOTE_REQUIRED');
    });

    it('rejects overly long notes', () => {
      expect(codeOf(() => service.record(request({ note: 'x'.repeat(281) })))).toBe('NOTE_TOO_LONG');
      expect(service.record(request({ note: 'x'.repeat(280) })).note).toHaveLength(280);
    });

    it('rejects a second cancellation of the same order with a different key', () => {
      service.record(request());
      expect(() => service.record(request({ idempotencyKey: 'key-other' }))).toThrow(ConflictException);
      expect(service.list()).toHaveLength(1);
    });

    it('detects tampering in the log', () => {
      service.record(request());
      service.record(request({ orderId: 2, idempotencyKey: 'key-2' }));
      const tampered = service.list();
      tampered[0] = { ...tampered[0], reasonCode: CancellationReasonCode.EXPIRED };
      expect(service.verifyChain(tampered)).toEqual({ valid: false, brokenAt: 1 });
    });
  });

  describe('retry path', () => {
    it('returns the original entry for a retry with the same key', () => {
      const first = service.record(request());
      clock += 5_000;
      expect(service.record(request())).toEqual(first);
      expect(service.list()).toHaveLength(1);
    });
  });

  describe('authorization', () => {
    it('owners can only cancel their own orders', () => {
      expect(() => service.record(request({ actor: { address: 'GOTHER', role: 'owner' } }))).toThrow(
        ForbiddenException,
      );
    });

    it.each([
      ['owner', CancellationReasonCode.ADMIN_HALT],
      ['owner', CancellationReasonCode.EXPIRED],
      ['system', CancellationReasonCode.USER_REQUESTED],
      ['system', CancellationReasonCode.ADMIN_HALT],
      ['admin', CancellationReasonCode.USER_REQUESTED],
    ] as const)('%s cannot use %s', (role, reasonCode) => {
      expect(
        codeOf(() =>
          service.record(request({ actor: { address: OWNER, role }, reasonCode, note: 'n' })),
        ),
      ).toBe('REASON_NOT_ALLOWED_FOR_ROLE');
    });

    it('system and admin may cancel orders they do not own with their reason codes', () => {
      expect(
        service.record(
          request({ actor: { address: 'keeper', role: 'system' }, reasonCode: CancellationReasonCode.KYC_REVOKED }),
        ).actorRole,
      ).toBe('system');
      expect(
        service.record(
          request({
            orderId: 2,
            actor: { address: 'GADMIN', role: 'admin' },
            reasonCode: CancellationReasonCode.COMPLIANCE_HOLD,
            note: 'sanctions review',
            idempotencyKey: 'key-2',
          }),
        ).actorRole,
      ).toBe('admin');
    });
  });
});
