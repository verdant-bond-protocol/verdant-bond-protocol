import { Injectable, Logger } from '@nestjs/common';
import {
  CancellationToken,
  OperationCancelledError,
} from './operation-cancellation.service';

export interface ImportRow {
    externalId: string;
    amount: number;
    targetAddress: string;
}

export interface ImportResult {
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    errorDetails: string[];
}

export interface ImportRunOptions {
    /** Cooperative cancellation token; checked between chunks. */
    token?: CancellationToken;
    /** Rows processed per checkpoint. Smaller = more responsive cancellation. */
    chunkSize?: number;
    /** Progress callback invoked after every chunk. */
    onChunk?: (progress: { processed: number; total: number; result: ImportResult }) => void;
}

export interface ImportRunOutcome {
    result: ImportResult;
    cancelled: boolean;
    /** Number of rows whose outcome was decided before stopping. */
    processed: number;
}

export const DEFAULT_IMPORT_CHUNK_SIZE = 100;

@Injectable()
export class BulkImportService {
    private readonly logger = new Logger(BulkImportService.name);

    constructor() {}

    /**
     * Executes a dry-run of the bulk import to validate inputs and calculate idempotency without persistence.
     */
    async dryRunImport(rows: ImportRow[]): Promise<ImportResult> {
        this.logger.log(`Starting dry-run for ${rows.length} rows.`);

        const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: 0, errorDetails: [] };
        const seenIds = new Set<string>();

        for (const [index, row] of rows.entries()) {
            this.processRow(row, index, seenIds, result);
        }

        this.logger.log(`Dry-run complete: ${result.created} created, ${result.errors} errors.`);
        return result;
    }

    /**
     * Run an import with cooperative, chunked cancellation (issue #404).
     *
     * Validation is identical to {@link dryRunImport}; the difference is that
     * the stop condition is checked **between chunks** so a cancellation never
     * tears a row in half. The partial {@link ImportResult} is always returned
     * alongside a `cancelled` flag, so the caller can persist progress and
     * resume/retry from a known-good point.
     */
    async runImport(rows: ImportRow[], options: ImportRunOptions = {}): Promise<ImportRunOutcome> {
        const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_IMPORT_CHUNK_SIZE);
        const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: 0, errorDetails: [] };
        const seenIds = new Set<string>();

        let processed = 0;
        let cancelled = false;
        this.logger.log(`Starting import of ${rows.length} rows (chunkSize=${chunkSize}).`);

        try {
            for (let offset = 0; offset < rows.length; offset += chunkSize) {
                // Safe cancellation point: stop between chunks, never mid-write.
                options.token?.throwIfCancelled();

                const end = Math.min(offset + chunkSize, rows.length);
                for (let index = offset; index < end; index++) {
                    this.processRow(rows[index], index, seenIds, result);
                    processed++;
                }

                options.onChunk?.({ processed, total: rows.length, result });
                await yieldToEventLoop();
            }

            // Catch a cancellation that arrived during the final chunk.
            options.token?.throwIfCancelled();
        } catch (error) {
            if (error instanceof OperationCancelledError) {
                cancelled = true;
                this.logger.warn(
                    `Import cancelled after ${processed}/${rows.length} rows: ${error.message}`,
                );
            } else {
                throw error;
            }
        }

        return { result, cancelled, processed };
    }

    private processRow(
        row: ImportRow,
        index: number,
        seenIds: Set<string>,
        result: ImportResult,
    ): void {
        if (!row.externalId || !row.targetAddress || row.amount <= 0) {
            result.errors++;
            result.errorDetails.push(`Row ${index}: Invalid schema or negative amount.`);
            return;
        }
        if (seenIds.has(row.externalId)) {
            result.skipped++;
            result.errorDetails.push(`Row ${index}: Duplicate externalId ${row.externalId} within batch.`);
            return;
        }

        seenIds.add(row.externalId);
        result.created++;
    }
}

function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}
