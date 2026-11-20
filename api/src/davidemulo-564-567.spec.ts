import { redactLogObject, resolveCorrelationId } from './common/interceptors/request-logging.interceptor';

describe('Davidemulo hardening checks (#564-#567)', () => {
  it('propagates or creates a correlation id and redacts credentials', () => {
    expect(resolveCorrelationId({ headers: { 'x-correlation-id': 'request-42' } })).toBe('request-42');
    expect(resolveCorrelationId({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
    const output = redactLogObject({ authorization: 'Bearer secret', retry: 2 });
    expect(output.authorization).toBe('[REDACTED]');
    expect(output.retry).toBe(2);
  });
});
