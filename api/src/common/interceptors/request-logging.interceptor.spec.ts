import { of, throwError } from 'rxjs';
import {
  redactLogObject,
  redactLogValue,
  RequestLoggingInterceptor,
} from './request-logging.interceptor';

describe('request logging correlation and redaction', () => {
  it('redacts secrets, signatures, transactions, and wallet addresses', () => {
    const redacted = redactLogObject({
      authorization: 'Bearer raw.jwt.token',
      sourceSecretKey: 'SAABC',
      signedTxXdr: 'AAAA',
      transactionHash: 'hash',
      walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      nested: {
        holder: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      },
    });

    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.sourceSecretKey).toBe('[REDACTED]');
    expect(redacted.signedTxXdr).toBe('[REDACTED]');
    expect(redacted.transactionHash).toBe('[REDACTED]');
    expect(redacted.walletAddress).toBe('GABCDE...WXYZ');
    expect((redacted.nested as any).holder).toBe('GABCDE...WXYZ');
  });

  it('sets a stable x-correlation-id response header', (done) => {
    const setHeader = jest.fn();
    const context: any = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/health',
          headers: { 'x-correlation-id': 'test-correlation-id' },
          body: {},
        }),
        getResponse: () => ({ setHeader }),
      }),
    };
    const interceptor = new RequestLoggingInterceptor();

    interceptor.intercept(context, { handle: () => of({ ok: true }) } as any).subscribe({
      complete: () => {
        expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'test-correlation-id');
        done();
      },
    });
  });

  it('redacts sensitive keys nested three levels deep', () => {
    const result = redactLogObject({
      level1: {
        level2: {
          token: 'should-be-gone',
          amount: '100',
        },
      },
    });
    expect((result.level1 as any).level2.token).toBe('[REDACTED]');
    expect((result.level1 as any).level2.amount).toBe('100');
  });

  it('truncates Stellar addresses inside an array of log objects', () => {
    const result = redactLogValue([
      { from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
      { amount: '500' },
    ]);
    expect((result as any[])[0].from).toBe('GABCDE...WXYZ');
    expect((result as any[])[1].amount).toBe('500');
  });

  it('passes non-string, non-sensitive values through unchanged', () => {
    const result = redactLogObject({
      statusCode: 200,
      success: true,
      count: null,
    });
    expect(result.statusCode).toBe(200);
    expect(result.success).toBe(true);
    expect(result.count).toBeNull();
  });

  it('preserves thrown errors while helper redaction hides secret fields', (done) => {
    const context: any = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          url: '/api/contracts',
          headers: {},
          body: { sourceSecretKey: 'raw-secret' },
        }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    };
    const interceptor = new RequestLoggingInterceptor();

    interceptor.intercept(context, { handle: () => throwError(() => new Error('boom')) } as any).subscribe({
      error: (err) => {
        expect(redactLogValue({ sourceSecretKey: 'raw-secret' })).toEqual({
          sourceSecretKey: '[REDACTED]',
        });
        expect(err.message).toBe('boom');
        done();
      },
    });
  });
});
