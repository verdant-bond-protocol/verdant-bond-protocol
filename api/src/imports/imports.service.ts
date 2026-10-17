import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BulkImportService, ImportResult, ImportRow } from '../common/services/bulk-import.service';
import { OperationCancellationService } from '../common/services/operation-cancellation.service';

export type ImportStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface ImportOperationView {
  operationId: string;
  status: ImportStatus;
  total: number;
  processed: number;
  result: ImportResult;
  reason?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
}

export const IMPORT_ADMIN_ROLE = 'ADMIN';

interface StoredOperation extends ImportOperationView {
  userId: string;
  rows: ImportRow[];
  chunkSize: number;
}

/**
 * Long-running bulk imports with safe, cooperative cancellation (issue #404).
 *
 * An import is started and tracked under an `operationId`. A running import can
 * be cancelled by its owner (or an admin); because cancellation is checked
 * between chunks, the import stops at a row boundary and reports the rows it
 * already processed. Cancelling an unknown or already-finished operation is
 * idempotent, and a cancelled/failed import can be retried.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);
  private readonly operations = new Map<string, StoredOperation>();
  private sequence = 0;

  constructor(
    private readonly bulkImport: BulkImportService,
    private readonly cancellation: OperationCancellationService,
  ) {}

  async startImport(
    userId: string,
    rows: ImportRow[],
    options: { chunkSize?: number } = {},
  ): Promise<ImportOperationView> {
    if (!rows || rows.length === 0) {
      throw new BadRequestException('an import requires at least one row');
    }

    const operationId = `imp_${Date.now().toString(36)}_${(this.sequence++).toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const now = new Date().toISOString();
    const operation: StoredOperation = {
      operationId,
      userId,
      rows: [...rows],
      chunkSize: Math.max(1, options.chunkSize ?? 100),
      status: 'running',
      total: rows.length,
      processed: 0,
      result: emptyResult(),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    this.operations.set(operationId, operation);

    const token = this.cancellation.start(operationId, 'import');
    return this.run(operation, token);
  }

  getImport(operationId: string): ImportOperationView {
    return this.toView(this.require(operationId));
  }

  listImports(): ImportOperationView[] {
    return [...this.operations.values()].map((op) => this.toView(op));
  }

  /**
   * Cancel a running import. Owner-or-admin only. Idempotent: cancelling an
   * already-cancelled or completed import returns its current view unchanged.
   */
  cancelImport(operationId: string, actor: { userId: string; role?: string }): ImportOperationView {
    const operation = this.require(operationId);
    this.assertCanControl(operation, actor);

    if (operation.status === 'running') {
      operation.reason = `cancelled by ${actor.userId}`;
      const flipped = this.cancellation.cancel(operationId, operation.reason);
      this.logger.log(`cancel requested for ${operationId} (flipped=${flipped})`);
    }
    return this.toView(operation);
  }

  /** Re-run a cancelled or failed import. Owner-or-admin only. */
  async retryImport(
    operationId: string,
    actor: { userId: string; role?: string },
  ): Promise<ImportOperationView> {
    const operation = this.require(operationId);
    this.assertCanControl(operation, actor);

    if (operation.status === 'running') {
      throw new BadRequestException(`import ${operationId} is already running`);
    }
    if (operation.status === 'completed') {
      return this.toView(operation);
    }

    operation.result = emptyResult();
    operation.processed = 0;
    operation.reason = undefined;
    operation.cancelledAt = undefined;
    operation.updatedAt = new Date().toISOString();
    operation.status = 'running';

    const token = this.cancellation.start(operationId, 'import');
    return this.run(operation, token);
  }

  private async run(
    operation: StoredOperation,
    token: ReturnType<OperationCancellationService['start']>,
  ): Promise<ImportOperationView> {
    operation.attempts++;
    operation.status = 'running';
    operation.updatedAt = new Date().toISOString();

    const outcome = await this.bulkImport.runImport(operation.rows, {
      token,
      chunkSize: operation.chunkSize,
      onChunk: (progress) => {
        operation.processed = progress.processed;
        operation.result = progress.result;
        operation.updatedAt = new Date().toISOString();
      },
    });

    operation.result = outcome.result;
    operation.processed = outcome.processed;
    operation.updatedAt = new Date().toISOString();

    if (outcome.cancelled) {
      operation.status = 'cancelled';
      operation.cancelledAt = operation.updatedAt;
      operation.reason = token.reason ?? operation.reason;
    } else {
      operation.status = 'completed';
      this.cancellation.release(operation.operationId);
    }

    return this.toView(operation);
  }

  private require(operationId: string): StoredOperation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new NotFoundException(`import ${operationId} not found`);
    }
    return operation;
  }

  private assertCanControl(
    operation: StoredOperation,
    actor: { userId: string; role?: string },
  ): void {
    if (operation.userId === actor.userId || actor.role === IMPORT_ADMIN_ROLE) {
      return;
    }
    throw new ForbiddenException(`cannot control import ${operation.operationId} outside your authorization scope`);
  }

  private toView(operation: StoredOperation): ImportOperationView {
    return {
      operationId: operation.operationId,
      status: operation.status,
      total: operation.total,
      processed: operation.processed,
      result: operation.result,
      reason: operation.reason,
      cancelledAt: operation.cancelledAt,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      attempts: operation.attempts,
    };
  }
}

function emptyResult(): ImportResult {
  return { created: 0, updated: 0, skipped: 0, errors: 0, errorDetails: [] };
}
