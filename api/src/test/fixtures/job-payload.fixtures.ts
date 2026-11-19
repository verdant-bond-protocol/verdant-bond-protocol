import { JobPayload, JobType, MAX_JOB_DATA_BYTES } from '../../workers/interfaces/job.interface';

/**
 * Deterministic fixtures for the job-enqueue security tests.
 *
 * These mirror real attack shapes: wrong types, oversized/non-JSON data,
 * prototype-pollution keys, unsafe identifiers, captured/replayed idempotency
 * keys, and privilege-escalation attempts. No randomness: a failing case
 * reproduces byte-for-byte.
 */

export const normalPayload: JobPayload = {
  type: JobType.DATA_EXPORT,
  data: { bondId: 'bond-123', format: 'csv' },
  userId: 'user-123',
  correlationId: 'corr-normal-001',
  idempotencyKey: 'idem-normal-001',
};

export interface MalformedFixture {
  name: string;
  field: string;
  payload: unknown;
}

export const malformedPayloadFixtures: MalformedFixture[] = [
  {
    name: 'missing type',
    field: 'type',
    payload: { data: {}, idempotencyKey: 'idem-bad-1' },
  },
  {
    name: 'unknown type',
    field: 'type',
    payload: { type: 'transfer_funds', data: {}, idempotencyKey: 'idem-bad-2' },
  },
  {
    name: 'non-string type',
    field: 'type',
    payload: { type: 42, data: {}, idempotencyKey: 'idem-bad-3' },
  },
  {
    name: 'array data',
    field: 'data',
    payload: { type: JobType.ORACLE_SYNC, data: [1, 2, 3], idempotencyKey: 'idem-bad-4' },
  },
  {
    name: 'null data',
    field: 'data',
    payload: { type: JobType.ORACLE_SYNC, data: null, idempotencyKey: 'idem-bad-5' },
  },
  {
    name: 'oversized data',
    field: 'data',
    payload: {
      type: JobType.DATA_EXPORT,
      data: { blob: 'x'.repeat(MAX_JOB_DATA_BYTES) },
      idempotencyKey: 'idem-bad-6',
    },
  },
  {
    name: 'prototype pollution key',
    field: 'data.__proto__',
    payload: {
      type: JobType.PORTFOLIO_REBALANCE,
      data: JSON.parse('{"__proto__":{"polluted":true}}'),
      idempotencyKey: 'idem-bad-7',
    },
  },
  {
    name: 'constructor key',
    field: 'data.constructor',
    payload: {
      type: JobType.RECONCILIATION,
      data: JSON.parse('{"constructor":{"prototype":{"x":1}}}'),
      idempotencyKey: 'idem-bad-8',
    },
  },
  {
    name: 'unsafe correlation id',
    field: 'correlationId',
    payload: {
      type: JobType.ORACLE_SYNC,
      data: {},
      correlationId: 'corr\nwith-newline',
      idempotencyKey: 'idem-bad-9',
    },
  },
  {
    name: 'unsafe idempotency key',
    field: 'idempotencyKey',
    payload: {
      type: JobType.ORACLE_SYNC,
      data: {},
      idempotencyKey: 'idem bad key with spaces',
    },
  },
];

/** Two distinct payloads that share a key: the second is a replay. */
export const replayPayloads: [JobPayload, JobPayload] = [
  { ...normalPayload, correlationId: 'corr-replay-1', idempotencyKey: 'idem-replay-attack' },
  {
    ...normalPayload,
    data: { bondId: 'bond-999', format: 'json' },
    correlationId: 'corr-replay-2',
    idempotencyKey: 'idem-replay-attack',
  },
];

/** A key captured then replayed after the TTL window: a fresh job is expected. */
export const expiredReplayPayload: JobPayload = {
  ...normalPayload,
  correlationId: 'corr-replay-expired',
  idempotencyKey: 'idem-replay-attack',
};

/** Non-admin callers must not enqueue privileged job types. */
export const unauthorizedPayload: JobPayload = {
  type: JobType.RECONCILIATION,
  data: { dryRun: false },
  userId: 'attacker-1',
  correlationId: 'corr-unauth-1',
  idempotencyKey: 'idem-unauth-1',
};

/** Admin-only job type used in authorization success cases. */
export const privilegedPayload: JobPayload = {
  type: JobType.RECONCILIATION,
  data: { dryRun: true },
  userId: 'admin-1',
  correlationId: 'corr-admin-1',
  idempotencyKey: 'idem-admin-1',
};
