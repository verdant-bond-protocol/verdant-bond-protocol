import {
  OperationCancellationService,
  OperationCancelledError,
} from './operation-cancellation.service';

describe('OperationCancellationService', () => {
  let service: OperationCancellationService;

  beforeEach(() => {
    service = new OperationCancellationService();
  });

  it('a fresh token is not cancelled and throwIfCancelled is a no-op', () => {
    const token = service.start('op-1');

    expect(token.cancelled).toBe(false);
    expect(token.throwIfCancelled()).toBeUndefined();
    expect(service.isCancelled('op-1')).toBe(false);
  });

  it('cancel flips the token, records the reason/time, and makes throwIfCancelled throw', () => {
    const token = service.start('op-2', 'export');

    expect(service.cancel('op-2', 'operator request')).toBe(true);
    expect(token.cancelled).toBe(true);
    expect(token.reason).toBe('operator request');
    expect(token.signal.aborted).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow(OperationCancelledError);
  });

  it('cancelling twice is idempotent (second call reports it did not flip)', () => {
    service.start('op-3');

    expect(service.cancel('op-3')).toBe(true);
    expect(service.cancel('op-3')).toBe(false);
  });

  it('cancelling an unknown operation is a safe no-op', () => {
    expect(service.cancel('never-started')).toBe(false);
    expect(service.isCancelled('never-started')).toBe(false);
  });

  it('start is idempotent for a live operation and cannot drop a pending cancel', () => {
    const first = service.start('op-4');
    const second = service.start('op-4');

    expect(second).toBe(first);
    service.cancel('op-4');
    expect(first.cancelled).toBe(true);
  });

  it('retry: starting a cancelled operation replaces it with a fresh live token', () => {
    const first = service.start('op-5');
    service.cancel('op-5');

    const retried = service.start('op-5');

    expect(retried).not.toBe(first);
    expect(retried.cancelled).toBe(false);
  });

  it('listActive reports kind and cancellation state', () => {
    service.start('op-6', 'import');
    service.cancel('op-6', 'stop');

    expect(service.listActive()).toEqual([
      expect.objectContaining({ operationId: 'op-6', kind: 'import', cancelled: true, reason: 'stop' }),
    ]);
  });

  it('release removes the operation from the registry', () => {
    service.start('op-7');
    service.release('op-7');

    expect(service.get('op-7')).toBeUndefined();
    expect(service.listActive()).toEqual([]);
  });
});
