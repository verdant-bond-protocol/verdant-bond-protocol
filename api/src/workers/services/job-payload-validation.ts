import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  JobPayload,
  JobType,
  MAX_JOB_DATA_BYTES,
  MAX_JOB_KEY_LENGTH,
} from '../interfaces/job.interface';

/** Fields that must never appear in job data (prototype-pollution guard). */
const FORBIDDEN_DATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Conservative key charset: printable ASCII minus control/whitespace. */
const SAFE_KEY = /^[A-Za-z0-9._:\-]+$/;

export interface PayloadFieldError {
  field: string;
  reason: string;
}

/**
 * Malformed-job rejection. Uses the existing VALIDATION_FAILED taxonomy code so
 * no new error-code contract entry is required, and exposes machine-readable
 * field errors for clients and fixtures.
 */
export class MalformedJobPayloadException extends BadRequestException {
  constructor(readonly fieldErrors: PayloadFieldError[]) {
    super({
      error: 'Malformed Job Payload',
      code: ErrorCode.VALIDATION_FAILED,
      message: 'The job payload failed validation.',
      errors: fieldErrors,
    });
  }
}

export interface ValidatePayloadOptions {
  /** Reject when no idempotency key is present. Used by replay-sensitive types. */
  requireIdempotencyKey?: boolean;
  /** Override the serialized-data size cap (tests / operators). */
  maxDataBytes?: number;
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const byteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Pure, deterministic validation of an untrusted enqueue payload.
 *
 * Covers the malformed-payload paths exercised by the fixtures in
 * `test/fixtures/job-payload.fixtures.ts`: wrong/missing type, non-object or
 * oversized data, cyclic data, prototype-pollution keys, and unsafe
 * correlation/idempotency keys.
 */
export function validateJobPayload(
  payload: unknown,
  options: ValidatePayloadOptions = {},
): asserts payload is JobPayload {
  const errors: PayloadFieldError[] = [];

  if (!plainObject(payload)) {
    throw new MalformedJobPayloadException([
      { field: 'payload', reason: 'must be a plain JSON object' },
    ]);
  }

  const type = (payload as Record<string, unknown>).type;
  const knownTypes = new Set<string>(Object.values(JobType));
  if (typeof type !== 'string' || !knownTypes.has(type)) {
    errors.push({ field: 'type', reason: `must be one of: ${[...knownTypes].join(', ')}` });
  }

  const data = (payload as Record<string, unknown>).data;
  if (!plainObject(data)) {
    errors.push({ field: 'data', reason: 'must be a plain JSON object (not an array or null)' });
  } else {
    const size = byteLength(data);
    const cap = options.maxDataBytes ?? MAX_JOB_DATA_BYTES;
    if (!Number.isFinite(size) || size > cap) {
      errors.push({ field: 'data', reason: `serialized data exceeds ${cap} bytes` });
    }
    for (const key of Object.keys(data)) {
      if (FORBIDDEN_DATA_KEYS.has(key)) {
        errors.push({ field: `data.${key}`, reason: 'key is not permitted' });
      }
    }
  }

  const correlationId = (payload as Record<string, unknown>).correlationId;
  if (correlationId !== undefined && !validKey(correlationId)) {
    errors.push({ field: 'correlationId', reason: `must be a ${MAX_JOB_KEY_LENGTH}-char max safe string` });
  }

  const idempotencyKey = (payload as Record<string, unknown>).idempotencyKey;
  if (idempotencyKey !== undefined && !validKey(idempotencyKey)) {
    errors.push({ field: 'idempotencyKey', reason: `must be a ${MAX_JOB_KEY_LENGTH}-char max safe string` });
  }
  if (options.requireIdempotencyKey && idempotencyKey === undefined) {
    errors.push({ field: 'idempotencyKey', reason: 'is required for this job type' });
  }

  if (errors.length) throw new MalformedJobPayloadException(errors);
}

function validKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_JOB_KEY_LENGTH &&
    SAFE_KEY.test(value)
  );
}
