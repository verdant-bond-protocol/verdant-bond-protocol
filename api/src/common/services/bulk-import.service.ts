import { Injectable, Logger } from '@nestjs/common';

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
            if (!row.externalId || !row.targetAddress || row.amount <= 0) {
                result.errors++;
                result.errorDetails.push(`Row ${index}: Invalid schema or negative amount.`);
                continue;
            }
            if (seenIds.has(row.externalId)) {
                result.skipped++;
                result.errorDetails.push(`Row ${index}: Duplicate externalId ${row.externalId} within batch.`);
                continue;
            }
            
            seenIds.add(row.externalId);
            // In a real execution, we would query the DB for row.externalId to determine if it's an Update vs Create
            // For now, simulate a Create
            result.created++;
        }

        this.logger.log(`Dry-run complete: ${result.created} created, ${result.errors} errors.`);
        return result;
    }
}
