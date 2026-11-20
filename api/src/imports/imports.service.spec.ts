import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ImportsService } from './imports.service';
import { BulkImportService, ImportRow } from '../common/services/bulk-import.service';
import { OperationCancellationService } from '../common/services/operation-cancellation.service';

function makeService() {
  return new ImportsService(new BulkImportService(), new OperationCancellationService());
}

function rows(count: number): ImportRow[] {
  return Array.from({ length: count }, (_, i) => ({
    externalId: `ext-${i}`,
    amount: 10,
    targetAddress: `GADDRESS${i}`,
  }));
}

describe('ImportsService', () => {
  it('normal path: an import runs to completion and reports every row processed', async () => {
    const service = makeService();

    const result = await service.startImport('user-1', rows(25), { chunkSize: 5 });

    expect(result.status).toBe('completed');
    expect(result.total).toBe(25);
    expect(result.processed).toBe(25);
    expect(result.result.created).toBe(25);
    expect(result.attempts).toBe(1);
  });

  it('failure path: invalid rows are counted as errors but the import still completes', async () => {
    const service = makeService();
    const input: ImportRow[] = [
      { externalId: 'ok-1', amount: 5, targetAddress: 'GADDR1' },
      { externalId: '', amount: 5, targetAddress: 'GADDR2' },
      { externalId: 'neg', amount: -1, targetAddress: 'GADDR3' },
      { externalId: 'ok-1', amount: 5, targetAddress: 'GADDR4' },
    ];

    const result = await service.startImport('user-1', input, { chunkSize: 2 });

    expect(result.status).toBe('completed');
    expect(result.result.created).toBe(1);
    expect(result.result.errors).toBe(2);
    expect(result.result.skipped).toBe(1);
  });

  it('validation: an empty import is rejected', async () => {
    const service = makeService();
    await expect(service.startImport('user-1', [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancellation: a cancel request stops the import between chunks and returns partial progress', async () => {
    const service = makeService();
    const started = service.startImport('user-1', rows(100), { chunkSize: 1 });

    const [operation] = service.listImports();
    const cancelled = service.cancelImport(operation.operationId, { userId: 'user-1' });

    expect(cancelled.status).toBe('running');
    expect(cancelled.reason).toContain('user-1');

    const result = await started;
    expect(result.status).toBe('cancelled');
    expect(result.cancelledAt).toBeTruthy();
    expect(result.processed).toBeGreaterThan(0);
    expect(result.processed).toBeLessThan(100);
    expect(result.result.created).toBe(result.processed);
  });

  it('authorization: a non-owner without the admin role cannot cancel or retry', async () => {
    const service = makeService();
    const started = service.startImport('owner', rows(50), { chunkSize: 5 });
    const [operation] = service.listImports();

    expect(() =>
      service.cancelImport(operation.operationId, { userId: 'stranger', role: 'INVESTOR' }),
    ).toThrow(ForbiddenException);

    service.cancelImport(operation.operationId, { userId: 'owner' });
    await started;

    await expect(
      service.retryImport(operation.operationId, { userId: 'stranger', role: 'INVESTOR' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('authorization: an admin can cancel an import they do not own', async () => {
    const service = makeService();
    const started = service.startImport('owner', rows(50), { chunkSize: 5 });
    const [operation] = service.listImports();

    service.cancelImport(operation.operationId, { userId: 'admin', role: 'ADMIN' });
    const result = await started;

    expect(result.status).toBe('cancelled');
  });

  it('retry: a cancelled import can be retried and then completes', async () => {
    const service = makeService();
    const started = service.startImport('user-1', rows(40), { chunkSize: 1 });
    const [operation] = service.listImports();
    service.cancelImport(operation.operationId, { userId: 'user-1' });
    const first = await started;
    expect(first.status).toBe('cancelled');

    const retried = await service.retryImport(operation.operationId, { userId: 'user-1' });

    expect(retried.status).toBe('completed');
    expect(retried.processed).toBe(40);
    expect(retried.result.created).toBe(40);
    expect(retried.attempts).toBe(2);
  });

  it('retrying a completed import is an idempotent no-op', async () => {
    const service = makeService();
    const done = await service.startImport('user-1', rows(3), { chunkSize: 3 });

    const again = await service.retryImport(done.operationId, { userId: 'user-1' });

    expect(again.status).toBe('completed');
    expect(again.attempts).toBe(1);
  });

  it('unknown operation ids surface as 404', () => {
    const service = makeService();
    expect(() => service.getImport('missing')).toThrow(NotFoundException);
    expect(() => service.cancelImport('missing', { userId: 'x' })).toThrow(NotFoundException);
  });
});
