import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from '../services/idempotency.service';
import { ExecutionContext, ConflictException } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';

function makeContext(method: string, url: string, body: unknown, key?: string): ExecutionContext {
  const request: any = { method, url, originalUrl: url, body, headers: {} as Record<string, string> };
  if (key) request.headers['idempotency-key'] = key;
  const response: any = { statusCode: 200 };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };

describe('IdempotencyInterceptor', () => {
  let idempotency: {
    get: jest.Mock;
    markPending: jest.Mock;
    complete: jest.Mock;
  };

  beforeEach(() => {
    idempotency = {
      get: jest.fn().mockResolvedValue(null),
      markPending: jest.fn().mockResolvedValue(true),
      complete: jest.fn().mockResolvedValue(undefined),
    };
  });

  function build(): IdempotencyInterceptor {
    return new IdempotencyInterceptor(reflector as any, idempotency as any);
  }

  const fingerprint = (body: unknown) =>
    IdempotencyService.fingerprintOf('POST', '/x', body);

  it('passes through when no idempotency key is supplied', async () => {
    const handler = { handle: () => of({ ok: true }) };
    const obs = await build().intercept(makeContext('POST', '/x', { a: 1 }), handler as any);
    expect(await lastValueFrom(obs)).toEqual({ ok: true });
  });

  it('returns the stored result on a duplicate retry (same fingerprint)', async () => {
    const fp = fingerprint({ a: 1 });
    idempotency.get.mockResolvedValue({ status: 'success', fingerprint: fp, result: { dup: true } });
    const handler = { handle: jest.fn().mockReturnValue(of({ executed: true })) };
    const obs = await build().intercept(makeContext('POST', '/x', { a: 1 }, 'key1'), handler as any);
    expect(await lastValueFrom(obs)).toEqual({ dup: true });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('rejects a conflicting reuse with a different payload', async () => {
    idempotency.get.mockResolvedValue({ status: 'success', fingerprint: 'different', result: {} });
    await expect(
      build().intercept(makeContext('POST', '/x', { a: 1 }, 'key1'), { handle: jest.fn() } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a still-pending key as in-progress', async () => {
    idempotency.get.mockResolvedValue({ status: 'pending', fingerprint: fingerprint({ a: 1 }) });
    await expect(
      build().intercept(makeContext('POST', '/x', { a: 1 }, 'key1'), { handle: jest.fn() } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('executes and stores the result for a new key', async () => {
    const handler = { handle: () => of({ transactionHash: '0x1' }) };
    const obs = await build().intercept(makeContext('POST', '/x', { a: 1 }, 'key1'), handler as any);
    expect(await lastValueFrom(obs)).toEqual({ transactionHash: '0x1' });
    expect(idempotency.markPending).toHaveBeenCalledWith('key1', fingerprint({ a: 1 }));
    expect(idempotency.complete).toHaveBeenCalledWith('key1', 'success', { transactionHash: '0x1' }, 200, fingerprint({ a: 1 }));
  });

  it('stores an error record when the handler fails', async () => {
    const handler = { handle: () => throwError(() => new Error('boom')) };
    const obs = await build().intercept(makeContext('POST', '/x', { a: 1 }, 'key1'), handler as any);
    await expect(lastValueFrom(obs)).rejects.toThrow('boom');
    expect(idempotency.complete).toHaveBeenCalledWith('key1', 'error', { message: 'boom' }, 200, fingerprint({ a: 1 }));
  });
});