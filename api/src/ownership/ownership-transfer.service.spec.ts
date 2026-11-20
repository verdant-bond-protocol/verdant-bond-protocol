import {
  OwnershipTransferError,
  OwnershipTransferService,
} from './ownership-transfer.service';

describe('OwnershipTransferService (#542)', () => {
  it('normal path: two-step initiate and accept transfers ownership and records audit history', () => {
    let clock = 1_700_000_000_000;
    const svc = new OwnershipTransferService(() => clock);
    svc.registerResource('bond:101', 'alice');

    const pending = svc.initiate({
      resourceId: 'bond:101',
      actorId: 'alice',
      toOwnerId: 'bob',
      ttlMs: 60_000,
    });
    expect(pending.status).toBe('PENDING');
    expect(svc.getOwner('bond:101')).toBe('alice');

    clock += 5_000;
    const accepted = svc.accept(pending.id, 'bob');
    expect(accepted.status).toBe('ACCEPTED');
    expect(svc.getOwner('bond:101')).toBe('bob');

    const history = svc.getAuditHistory('bond:101');
    expect(history.map((e) => e.action)).toEqual(['INITIATED', 'ACCEPTED']);
  });

  it('failure & expiry path: rejects acceptance past TTL and preserves original owner', () => {
    let clock = 1_700_000_000_000;
    const svc = new OwnershipTransferService(() => clock);
    svc.registerResource('bond:102', 'alice');

    const pending = svc.initiate({
      resourceId: 'bond:102',
      actorId: 'alice',
      toOwnerId: 'bob',
      ttlMs: 10_000,
    });

    clock += 15_000;
    expect(() => svc.accept(pending.id, 'bob')).toThrow(OwnershipTransferError);
    expect(svc.getOwner('bond:102')).toBe('alice');
    expect(svc.getAuditHistory('bond:102').map((e) => e.action)).toEqual([
      'INITIATED',
      'EXPIRED',
    ]);
  });

  it('retry path: owner can retry an expired transfer and complete handoff', () => {
    let clock = 1_700_000_000_000;
    const svc = new OwnershipTransferService(() => clock);
    svc.registerResource('bond:103', 'alice');

    const first = svc.initiate({
      resourceId: 'bond:103',
      actorId: 'alice',
      toOwnerId: 'bob',
      ttlMs: 5_000,
    });

    clock += 10_000;
    const retried = svc.retry(first.id, 'alice', 30_000);
    expect(retried.status).toBe('PENDING');

    const accepted = svc.accept(retried.id, 'bob');
    expect(accepted.status).toBe('ACCEPTED');
    expect(svc.getOwner('bond:103')).toBe('bob');
    expect(svc.getAuditHistory('bond:103').map((e) => e.action)).toEqual([
      'INITIATED',
      'EXPIRED',
      'INITIATED',
      'RETRIED',
      'ACCEPTED',
    ]);
  });

  it('authorization path: rejects non-owner initiation and third-party acceptance', () => {
    const svc = new OwnershipTransferService();
    svc.registerResource('bond:104', 'alice');

    expect(() =>
      svc.initiate({ resourceId: 'bond:104', actorId: 'mallory', toOwnerId: 'bob' }),
    ).toThrow(OwnershipTransferError);

    const pending = svc.initiate({
      resourceId: 'bond:104',
      actorId: 'alice',
      toOwnerId: 'bob',
    });

    expect(() => svc.accept(pending.id, 'mallory')).toThrow(OwnershipTransferError);
    expect(svc.getOwner('bond:104')).toBe('alice');
  });
});
