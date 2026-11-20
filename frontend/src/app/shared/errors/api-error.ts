import { HttpErrorResponse } from '@angular/common/http';

export interface AppError {
  status: number;
  title: string;
  detail: string;
  code?: string;
}

function formatDetail(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    const details = value.filter((item): item is string => typeof item === 'string');
    if (details.length) return details.join(', ');
  }
  return undefined;
}

export function normalizeApiError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const response = error instanceof HttpErrorResponse ? error : undefined;
  const body = response?.error as Record<string, unknown> | undefined;
  const detail = formatDetail(body?.['detail'])
    ?? formatDetail(body?.['message'])
    ?? formatDetail(body?.['error'])
    ?? (error instanceof Error ? error.message : undefined)
    ?? 'Request failed';

  return {
    status: response?.status ?? 0,
    title: formatDetail(body?.['title']) ?? (response?.statusText || 'Request failed'),
    detail,
    ...(typeof body?.['code'] === 'string' ? { code: body['code'] } : {}),
  };
}

export function appErrorMessage(error: unknown, fallback: string): string {
  return normalizeApiError(error).detail || fallback;
}

function isAppError(error: unknown): error is AppError {
  return typeof error === 'object'
    && error !== null
    && typeof (error as AppError).detail === 'string'
    && typeof (error as AppError).status === 'number';
}