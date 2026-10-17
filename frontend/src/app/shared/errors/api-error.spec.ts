import { HttpErrorResponse } from '@angular/common/http';
import { AppError, appErrorMessage, normalizeApiError } from './api-error';

describe('normalizeApiError (#373)', () => {
  it('passes through an error that already matches the AppError shape', () => {
    const appError: AppError = { status: 409, title: 'Conflict', detail: 'Already filled' };

    expect(normalizeApiError(appError)).toBe(appError);
  });

  it('normalizes an RFC 7807 response with an array detail into one message', () => {
    const response = new HttpErrorResponse({
      status: 400,
      statusText: 'Bad Request',
      error: { title: 'Bad Request', code: 'VALIDATION_FAILED', detail: ['name is required', 'country is required'] },
      url: '/api/projects',
    });

    expect(normalizeApiError(response)).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: 'name is required, country is required',
      code: 'VALIDATION_FAILED',
    });
  });

  it('falls back through detail, message and error fields', () => {
    const withMessage = new HttpErrorResponse({ status: 500, error: { message: 'boom' } });
    expect(normalizeApiError(withMessage).detail).toBe('boom');

    const withError = new HttpErrorResponse({ status: 502, error: { error: 'upstream down' } });
    expect(normalizeApiError(withError).detail).toBe('upstream down');
  });

  it('uses the status text as the title when the body has none', () => {
    const response = new HttpErrorResponse({ status: 404, statusText: 'Not Found', error: {} });

    const normalized = normalizeApiError(response);
    expect(normalized.status).toBe(404);
    expect(normalized.title).toBe('Not Found');
    expect(typeof normalized.detail).toBe('string');
  });

  it('never surfaces an empty detail, keeping error recovery announceable', () => {
    const response = new HttpErrorResponse({ status: 0, error: null });

    const normalized = normalizeApiError(response);
    expect(typeof normalized.detail).toBe('string');
    expect(normalized.detail.length).toBeGreaterThan(0);
    expect(typeof normalized.title).toBe('string');
  });
});

describe('appErrorMessage (#373)', () => {
  it('prefers the normalized detail', () => {
    const response = new HttpErrorResponse({ status: 400, error: { detail: 'Amount must be positive' } });

    expect(appErrorMessage(response, 'Buy failed')).toBe('Amount must be positive');
  });

  it('returns the caller fallback when the error carries an empty message', () => {
    expect(appErrorMessage(new Error(''), 'Buy failed')).toBe('Buy failed');
  });

  it('still produces an announceable message for a null error', () => {
    const message = appErrorMessage(null, 'Cancel failed');

    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });
});
