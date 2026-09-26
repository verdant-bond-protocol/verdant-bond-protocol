import { Injectable, Logger } from '@nestjs/common';

export interface SorobanEvent {
    id: string;
    transactionHash: string;
    ledgerSeq: number;
    opIndex: number;
    eventIndex: number;
    topic: string[];
    value: any;
}

@Injectable()
export class EventIngestionService {
    private readonly logger = new Logger(EventIngestionService.name);
    private readonly CONFIRMATION_DEPTH = 5; // e.g., 5 ledgers deep to handle transient state

    constructor() {}

    /**
     * Generates a deterministic idempotency key resilient to transaction re-hashing in reorgs.
     */
    generateIdempotencyKey(event: SorobanEvent): string {
        // Keying by (ledger, op, event) instead of transactionHash protects against duplicate
        // processing if a transaction is re-mined in a reorg, assuming the external system
        // resolves the ledger sequence deterministically.
        return `event:${event.ledgerSeq}:${event.opIndex}:${event.eventIndex}`;
    }

    /**
     * Determines if an event has met finality requirements before financial state updates.
     */
    isFinal(eventLedgerSeq: number, currentLedgerSeq: number): boolean {
        return (currentLedgerSeq - eventLedgerSeq) >= this.CONFIRMATION_DEPTH;
    }

    async processEventSafely(event: SorobanEvent, currentLedgerSeq: number): Promise<void> {
        if (!this.isFinal(event.ledgerSeq, currentLedgerSeq)) {
            this.logger.debug(`Event ${event.id} waiting for confirmation depth.`);
            return;
        }
        
        const idempotencyKey = this.generateIdempotencyKey(event);
        // ... Check Redis/DB for idempotencyKey to prevent duplicate execution ...
        this.logger.log(`Processing finalized event with key ${idempotencyKey}`);
    }
}
