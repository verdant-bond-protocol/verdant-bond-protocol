import {
  PartialSettlementRecoveryService,
  SettlementRecoveryAuthorizationError,
} from './partial-settlement-recovery.service';

describe('PartialSettlementRecoveryService (#441)', () => {
  it('normal path: completes all transfer legs and preserves supply invariants', async () => {
    const svc = new PartialSettlementRecoveryService();
    let sellerBalance = 100;
    let buyerBalance = 0;
    let escrowUsdc = 500;

    const res = await svc.executeOrRecover({
      settlementId: 'stl-1',
      bondId: 'bond-green-1',
      amount: '40',
      actorRole: 'SETTLEMENT_MANAGER',
      legs: [
        {
          legId: 'debit-seller',
          execute: async () => { sellerBalance -= 40; },
          compensate: async () => { sellerBalance += 40; },
        },
        {
          legId: 'credit-buyer',
          execute: async () => { buyerBalance += 40; },
          compensate: async () => { buyerBalance -= 40; },
        },
        {
          legId: 'release-escrow',
          execute: async () => { escrowUsdc -= 500; },
          compensate: async () => { escrowUsdc += 500; },
        },
      ],
    });

    expect(res.status).toBe('COMPLETED');
    expect(sellerBalance + buyerBalance).toBe(100);
    expect(escrowUsdc).toBe(0);
  });

  it('failure & rollback path: compensates committed legs in LIFO order when final leg fails', async () => {
    const svc = new PartialSettlementRecoveryService();
    let sellerBalance = 100;
    let buyerBalance = 0;
    const rollbackOrder: string[] = [];

    const res = await svc.executeOrRecover({
      settlementId: 'stl-2',
      bondId: 'bond-green-1',
      amount: '40',
      actorRole: 'ADMIN',
      legs: [
        {
          legId: 'debit-seller',
          execute: async () => { sellerBalance -= 40; },
          compensate: async () => {
            sellerBalance += 40;
            rollbackOrder.push('debit-seller');
          },
        },
        {
          legId: 'credit-buyer',
          execute: async () => { buyerBalance += 40; },
          compensate: async () => {
            buyerBalance -= 40;
            rollbackOrder.push('credit-buyer');
          },
        },
        {
          legId: 'release-escrow',
          execute: async () => { throw new Error('Horizon tx_bad_seq'); },
          compensate: async () => { rollbackOrder.push('release-escrow'); },
        },
      ],
    });

    expect(res.status).toBe('RECOVERED_ROLLED_BACK');
    expect(rollbackOrder).toEqual(['credit-buyer', 'debit-seller']);
    expect(sellerBalance).toBe(100);
    expect(buyerBalance).toBe(0);
    expect(res.committedLegs).toEqual([]);
  });

  it('retry path: retries interrupted settlement and becomes idempotent once COMPLETED', async () => {
    const svc = new PartialSettlementRecoveryService();
    let failThirdLeg = true;
    let sellerBalance = 100;
    let buyerBalance = 0;

    const legs = [
      {
        legId: 'debit-seller',
        execute: async () => { sellerBalance -= 25; },
        compensate: async () => { sellerBalance += 25; },
      },
      {
        legId: 'credit-buyer',
        execute: async () => { buyerBalance += 25; },
        compensate: async () => { buyerBalance -= 25; },
      },
      {
        legId: 'release-escrow',
        execute: async () => {
          if (failThirdLeg) throw new Error('Transient RPC 503');
        },
        compensate: async () => {},
      },
    ];

    const first = await svc.executeOrRecover({
      settlementId: 'stl-retry',
      bondId: 'bond-1',
      amount: '25',
      actorRole: 'SETTLEMENT_MANAGER',
      legs,
    });
    expect(first.status).toBe('RECOVERED_ROLLED_BACK');
    expect(sellerBalance).toBe(100);

    failThirdLeg = false;
    const second = await svc.executeOrRecover({
      settlementId: 'stl-retry',
      bondId: 'bond-1',
      amount: '25',
      actorRole: 'SETTLEMENT_MANAGER',
      legs,
    });
    expect(second.status).toBe('COMPLETED');
    expect(sellerBalance).toBe(75);
    expect(buyerBalance).toBe(25);

    // Third call is an idempotent no-op
    const third = await svc.executeOrRecover({
      settlementId: 'stl-retry',
      bondId: 'bond-1',
      amount: '25',
      actorRole: 'SETTLEMENT_MANAGER',
      legs,
    });
    expect(third.attempts).toBe(2);
    expect(sellerBalance).toBe(75);
  });

  it('authorization path: rejects INVESTOR role before touching any transfer leg', async () => {
    const svc = new PartialSettlementRecoveryService();
    let executed = false;

    await expect(
      svc.executeOrRecover({
        settlementId: 'stl-unauth',
        bondId: 'bond-1',
        amount: '10',
        actorRole: 'INVESTOR',
        legs: [
          {
            legId: 'debit',
            execute: async () => { executed = true; },
            compensate: async () => {},
          },
        ],
      }),
    ).rejects.toThrow(SettlementRecoveryAuthorizationError);
    expect(executed).toBe(false);
  });
});
