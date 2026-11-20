import { DeliveryReceiptError, DeliveryReceiptLedger } from './delivery-receipts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

describe('DeliveryReceiptLedger (#539)', () => {
  let ledger: DeliveryReceiptLedger;

  beforeEach(() => {
    ledger = new DeliveryReceiptLedger({ maxAttempts: 2, pendingTimeoutMs: 1000 });
  });

  it('delivers once and suppresses duplicates', () => {
    const first = ledger.begin('u1', 'evt-1', 'email', T0);
    expect(first.duplicate).toBe(false);
    expect(ledger.begin('u1', 'evt-1', 'email', T0 + 10).duplicate).toBe(true);

    ledger.confirm(first.receipt.key, 'prov-1', T0 + 20);
    const again = ledger.begin('u1', 'evt-1', 'email', T0 + 30);
    expect(again.duplicate).toBe(true);
    expect(again.receipt.status).toBe('delivered');
    expect(again.receipt.attempts).toHaveLength(1);
  });

  it('dedupes per channel and per user', () => {
    expect(ledger.begin('u1', 'evt-1', 'email', T0).duplicate).toBe(false);
    expect(ledger.begin('u1', 'evt-1', 'in_app', T0).duplicate).toBe(false);
    expect(ledger.begin('u2', 'evt-1', 'email', T0).duplicate).toBe(false);
  });

  it('retries a failure then dead-letters after maxAttempts', () => {
    const { receipt } = ledger.begin('u1', 'evt-2', 'webhook', T0);
    ledger.fail(receipt.key, 'HTTP 503', T0 + 1);
    expect(receipt.status).toBe('failed');

    expect(ledger.begin('u1', 'evt-2', 'webhook', T0 + 2).duplicate).toBe(false);
    ledger.fail(receipt.key, 'HTTP 503', T0 + 3);
    expect(receipt.status).toBe('dead_lettered');
    expect(() => ledger.begin('u1', 'evt-2', 'webhook', T0 + 4)).toThrow(DeliveryReceiptError);
  });

  it('reclaims a pending delivery after the pending timeout', () => {
    ledger.begin('u1', 'evt-3', 'email', T0);
    const reclaimed = ledger.begin('u1', 'evt-3', 'email', T0 + 1500);
    expect(reclaimed.duplicate).toBe(false);
    expect(reclaimed.receipt.attempts[0].error).toBe('pending timeout');
    expect(reclaimed.receipt.attempts).toHaveLength(2);
  });

  it('confirm is idempotent but rejects a conflicting receipt', () => {
    const { receipt } = ledger.begin('u1', 'evt-4', 'email', T0);
    ledger.confirm(receipt.key, 'prov-a', T0 + 1);
    expect(ledger.confirm(receipt.key, 'prov-a', T0 + 2).deliveredAt).toBe(new Date(T0 + 1).toISOString());
    expect(() => ledger.confirm(receipt.key, 'prov-b', T0 + 3)).toThrow(/another receipt/);
    expect(() => ledger.fail(receipt.key, 'late failure')).toThrow(DeliveryReceiptError);
  });

  it('restricts receipt reads to the recipient or an admin', () => {
    ledger.begin('u1', 'evt-5', 'in_app', T0);
    expect(ledger.list('u1', { id: 'u1' })).toHaveLength(1);
    expect(ledger.list('u1', { id: 'ops', isAdmin: true })).toHaveLength(1);
    expect(() => ledger.list('u1', { id: 'u2' })).toThrow(/another user/);
  });

  it('rejects invalid input', () => {
    expect(() => ledger.begin('', 'evt', 'email')).toThrow(DeliveryReceiptError);
    expect(() => ledger.confirm('missing', 'x')).toThrow(/unknown delivery/);
    expect(() => new DeliveryReceiptLedger({ maxAttempts: 0 })).toThrow();
  });
});
