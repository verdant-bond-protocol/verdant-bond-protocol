import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface CarbonChainAttestation {
    projectId: string;
    sequenceNumber: number;
    metrics: Record<string, number>;
    signature: string;
    timestamp: string;
}

@Injectable()
export class CarbonChainProvider {
    private readonly logger = new Logger(CarbonChainProvider.name);
    // In-memory buffer for bounded reordering. In prod, use Redis.
    private sequenceTracker = new Map<string, number>();
    private pendingBuffer = new Map<string, CarbonChainAttestation[]>();
    private readonly MAX_REORDER_WINDOW = 50;

    constructor() {}

    /**
     * Verifies the cryptographic signature of the attestation.
     */
    verifySignature(attestation: CarbonChainAttestation, publicKey: string): boolean {
        const { signature, ...payload } = attestation;
        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(payload));
        return verify.verify(publicKey, signature, 'base64');
    }

    /**
     * Processes an attestation, handling sequence numbers and out-of-order delivery.
     */
    async processAttestation(attestation: CarbonChainAttestation, publicKey: string): Promise<boolean> {
        if (!this.verifySignature(attestation, publicKey)) {
            this.logger.error(`Invalid signature for project ${attestation.projectId}`);
            throw new Error('Invalid signature');
        }

        const currentSeq = this.sequenceTracker.get(attestation.projectId) || 0;
        
        if (attestation.sequenceNumber <= currentSeq) {
            this.logger.warn(`Replay detected for project ${attestation.projectId} (seq: ${attestation.sequenceNumber})`);
            return false; // Replay attack or duplicate
        }

        if (attestation.sequenceNumber > currentSeq + 1) {
            if (attestation.sequenceNumber - currentSeq > this.MAX_REORDER_WINDOW) {
                throw new Error('Sequence gap exceeds reorder window');
            }
            // Buffer out-of-order
            const buffer = this.pendingBuffer.get(attestation.projectId) || [];
            buffer.push(attestation);
            this.pendingBuffer.set(attestation.projectId, buffer.sort((a, b) => a.sequenceNumber - b.sequenceNumber));
            return true; // Buffered
        }

        // Exact next sequence
        this.sequenceTracker.set(attestation.projectId, attestation.sequenceNumber);
        this.logger.log(`Processed attestation ${attestation.sequenceNumber} for project ${attestation.projectId}`);
        
        // Drain buffer
        const buffer = this.pendingBuffer.get(attestation.projectId) || [];
        while (buffer.length > 0 && buffer[0].sequenceNumber === (this.sequenceTracker.get(attestation.projectId) || 0) + 1) {
            const next = buffer.shift()!;
            this.sequenceTracker.set(attestation.projectId, next.sequenceNumber);
            this.logger.log(`Processed buffered attestation ${next.sequenceNumber} for project ${next.projectId}`);
        }
        return true;
    }
}
