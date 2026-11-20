import { DexReconciliationScheduler } from './dex.reconciliation.scheduler';
import { DexReconciliationService } from './dex.reconciliation.service';

describe('DexReconciliationScheduler', () => {
  it('runs the reconciliation job and surfaces the result without throwing', async () => {
    const original = process.env.DEX_ROUTER_ADDRESS;
    process.env.DEX_ROUTER_ADDRESS = 'CDEXROUTER';
    const reconciliation = {
      reconcile: jest.fn().mockResolvedValue({ correlationId: 'c', mismatches: [] }),
    } as any;
    const scheduler = new DexReconciliationScheduler(reconciliation);

    await scheduler.runReconciliation();

    expect(reconciliation.reconcile).toHaveBeenCalled();
    if (original) process.env.DEX_ROUTER_ADDRESS = original;
  });

  it('skips when the DEX router is not configured', async () => {
    const original = process.env.DEX_ROUTER_ADDRESS;
    delete process.env.DEX_ROUTER_ADDRESS;
    const reconciliation = { reconcile: jest.fn() } as any;
    const scheduler = new DexReconciliationScheduler(reconciliation);

    await scheduler.runReconciliation();

    expect(reconciliation.reconcile).not.toHaveBeenCalled();
    if (original) process.env.DEX_ROUTER_ADDRESS = original;
  });
});
