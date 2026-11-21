import { ForbiddenException, BadRequestException } from '@nestjs/common';
import {
  EventIngestionService,
  SorobanEvent,
  compareSorobanEvents,
} from './event-ingestion.service';

describe('EventIngestionService & Deterministic Ordering (#633)', () => {
  let service: EventIngestionService;

  const createEvent = (
    id: string,
    ledgerSeq: number,
    opIndex: number,
    eventIndex: number,
    type = 'bond.subscribed',
  ): SorobanEvent => ({
    id,
    transactionHash: `tx_${ledgerSeq}_${opIndex}`,
    ledgerSeq,
    opIndex,
    eventIndex,
    topic: [type],
    value: { amount: '500' },
  });

  beforeEach(() => {
    service = new EventIngestionService();
  });

  describe('compareSorobanEvents (Total Order Tuple)', () => {
    it('orders primarily by ledger sequence ascending', () => {
      const e1 = createEvent('ev_1', 100, 0, 0);
      const e2 = createEvent('ev_2', 101, 0, 0);

      expect(compareSorobanEvents(e1, e2)).toBeLessThan(0);
      expect(compareSorobanEvents(e2, e1)).toBeGreaterThan(0);
    });

    it('orders intra-ledger events by opIndex then eventIndex', () => {
      const e1 = createEvent('ev_1', 100, 0, 1);
      const e2 = createEvent('ev_2', 100, 1, 0);
      const e3 = createEvent('ev_3', 100, 1, 1);

      expect(compareSorobanEvents(e1, e2)).toBeLessThan(0);
      expect(compareSorobanEvents(e2, e3)).toBeLessThan(0);
    });

    it('breaks ties deterministically using unique event id', () => {
      const e1 = createEvent('ev_alpha', 100, 1, 0);
      const e2 = createEvent('ev_beta', 100, 1, 0);

      expect(compareSorobanEvents(e1, e2)).toBeLessThan(0);
    });
  });

  describe('Normal Path & Deterministic Batch Processing', () => {
    it('orders an arbitrarily shuffled batch into strict chronological order', async () => {
      const currentLedger = 120; // well past confirmation depth of 5
      const events: SorobanEvent[] = [
        createEvent('ev_3', 102, 0, 0),
        createEvent('ev_1', 101, 0, 0),
        createEvent('ev_4', 102, 1, 0),
        createEvent('ev_2', 101, 0, 1),
      ];

      const processedOrder: string[] = [];
      const report = await service.processBatchWithDeterministicOrdering(
        events,
        currentLedger,
        async (ev) => {
          processedOrder.push(ev.id);
        },
      );

      expect(report.status).toBe('SUCCESS');
      expect(report.processedCount).toBe(4);
      expect(report.skippedDuplicatesCount).toBe(0);
      expect(processedOrder).toEqual(['ev_1', 'ev_2', 'ev_3', 'ev_4']);
      expect(report.lastCommittedLedgerSeq).toBe(102);
    });

    it('defers unfinalized events waiting for confirmation depth', async () => {
      const currentLedger = 103; // ledger 100 is final (diff 3 < 5 -> not final!)
      const events = [createEvent('ev_unfinalized', 100, 0, 0)];

      const report = await service.processBatchWithDeterministicOrdering(events, currentLedger);

      expect(report.status).toBe('UNFINALIZED_DEFERRED');
      expect(report.deferredCount).toBe(1);
      expect(report.processedCount).toBe(0);
    });
  });

  describe('Failure Path (Sequence Gap Detection)', () => {
    it('halts and returns GAP_DETECTED when a ledger is skipped', async () => {
      // First batch completes ledger 100
      await service.processBatchWithDeterministicOrdering(
        [createEvent('ev_1', 100, 0, 0)],
        110,
      );
      expect(service.getCheckpoint().lastCommittedLedgerSeq).toBe(100);

      // Second batch arrives with ledger 103 (skipping 101 and 102)
      const report = await service.processBatchWithDeterministicOrdering(
        [createEvent('ev_gap', 103, 0, 0)],
        110,
      );

      expect(report.status).toBe('GAP_DETECTED');
      expect(report.gapDetails?.expectedLedger).toBe(101);
      expect(report.gapDetails?.receivedLedger).toBe(103);
      expect(report.processedCount).toBe(0);
    });
  });

  describe('Retry Path (Restart Replay & Deduplication)', () => {
    it('is idempotent: replaying after restart skips already-committed events', async () => {
      const currentLedger = 115;
      const batch = [
        createEvent('ev_1', 101, 0, 0),
        createEvent('ev_2', 101, 1, 0),
      ];

      const firstExec: string[] = [];
      await service.processBatchWithDeterministicOrdering(batch, currentLedger, async (ev) => {
        firstExec.push(ev.id);
      });
      expect(firstExec).toEqual(['ev_1', 'ev_2']);

      // Replay batch (simulating restart replay from checkpoint)
      const secondExec: string[] = [];
      const report = await service.processBatchWithDeterministicOrdering(
        batch,
        currentLedger,
        async (ev) => {
          secondExec.push(ev.id);
        },
      );

      expect(report.status).toBe('SUCCESS');
      expect(report.processedCount).toBe(0);
      expect(report.skippedDuplicatesCount).toBe(2);
      expect(secondExec).toHaveLength(0); // Zero duplicate execution!
    });
  });

  describe('Authorization Path (Checkpoint Reset)', () => {
    it('forbids unauthorized non-admin from resetting checkpoint', () => {
      expect(() => {
        service.resetCheckpoint(50, { isAdmin: false });
      }).toThrow(ForbiddenException);

      expect(() => {
        service.resetCheckpoint(50, undefined);
      }).toThrow(ForbiddenException);
    });

    it('allows authorized admin to rewind checkpoint for backfill', () => {
      const updated = service.resetCheckpoint(50, { isAdmin: true });
      expect(updated.lastCommittedLedgerSeq).toBe(50);
    });

    it('rejects negative target ledger sequences', () => {
      expect(() => {
        service.resetCheckpoint(-1, { isAdmin: true });
      }).toThrow(BadRequestException);
    });
  });
});

