import { Controller, Get, HttpException, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Rfc7807ExceptionFilter } from '../filters/rfc7807-exception.filter';
import { buildControllerApp } from '../../test/controller-guard.harness';
import { ApiProblemException } from './problem-exception';
import { ErrorCode, ErrorTaxonomy, problemTypeUri } from './error-codes';

/** Minimal controller that throws through every filter branch under test. */
@Controller('problems')
class ProblemsController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('connection string leaked: postgres://user:password@host/db');
  }

  @Get('retry')
  retry(): never {
    throw new HttpException(
      { code: ErrorCode.QUEUE_BACKPRESSURE, retryAfterSeconds: 7, message: 'queue saturated' },
      429,
    );
  }

  @Get('step-up')
  stepUp(): never {
    throw new ApiProblemException(ErrorCode.STEP_UP_REQUIRED, { status: 401 });
  }

  @Get('risk-review')
  riskReview(): never {
    throw new ApiProblemException(ErrorCode.RISK_REVIEW_REQUIRED, {
      status: 403,
      context: { reviewId: 'rvw-1' },
    });
  }

  @Get('unknown-code')
  unknownCode(): never {
    throw new HttpException({ code: 'MADE_UP_CODE', message: 'gone' }, 404);
  }
}

/**
 * HTTP contract for stable error codes and remediation hints (#376): the
 * public problem-details response is exercised through the real global filter
 * used by `app.module.ts`. No wire field is added here — this pins behaviour.
 */
describe('Stable API error codes and remediation hints (HTTP contract)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildControllerApp(ProblemsController, [], (nest) => {
      nest.useGlobalFilters(new Rfc7807ExceptionFilter());
    });
  });

  afterAll(() => app.close());

  const get = (path: string) => request(app.getHttpServer()).get(`/problems/${path}`);

  it('normal path: a successful response carries no problem fields', async () => {
    const res = await get('ok').expect(200);
    expect(res.body).toEqual({ ok: true });
    for (const field of ['code', 'remediation', 'retryable', 'type', 'instance']) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  it('failure path: unexpected errors map to INTERNAL_ERROR without leaking details', async () => {
    const res = await get('unknown').expect(500);
    expect(res.body).toMatchObject({
      type: problemTypeUri(ErrorCode.INTERNAL_ERROR),
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
      instance: '/problems/unknown',
      retryable: false,
      remediation: ErrorTaxonomy[ErrorCode.INTERNAL_ERROR].remediation,
    });
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/postgres|password|user:password/);
  });

  it('retry path: a retryable code emits retryable=true and Retry-After', async () => {
    const res = await get('retry').expect(429);
    expect(res.body).toMatchObject({
      code: ErrorCode.QUEUE_BACKPRESSURE,
      retryable: true,
      remediation: ErrorTaxonomy[ErrorCode.QUEUE_BACKPRESSURE].remediation,
    });
    expect(res.headers['retry-after']).toBe('7');
  });

  it('authorization path: step-up and review codes keep their status and context', async () => {
    const stepUp = await get('step-up').expect(401);
    expect(stepUp.body).toMatchObject({
      code: ErrorCode.STEP_UP_REQUIRED,
      status: 401,
      retryable: true,
      remediation: ErrorTaxonomy[ErrorCode.STEP_UP_REQUIRED].remediation,
    });

    const review = await get('risk-review').expect(403);
    expect(review.body).toMatchObject({
      code: ErrorCode.RISK_REVIEW_REQUIRED,
      status: 403,
      retryable: false,
      context: { reviewId: 'rvw-1' },
      remediation: ErrorTaxonomy[ErrorCode.RISK_REVIEW_REQUIRED].remediation,
    });
  });

  it('fallback: an unknown self-declared code falls back to the status-derived code', async () => {
    const res = await get('unknown-code').expect(404);
    expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    expect(res.body.remediation).toBe(ErrorTaxonomy[ErrorCode.NOT_FOUND].remediation);
  });

  it('never serializes operator-only remediation hints to clients', async () => {
    for (const path of ['unknown', 'retry', 'step-up', 'risk-review', 'unknown-code']) {
      const res = await get(path);
      const body = JSON.stringify(res.body);
      for (const code of Object.values(ErrorCode)) {
        expect(body.includes(ErrorTaxonomy[code].remediationHint)).toBe(false);
      }
      expect(res.body).not.toHaveProperty('remediationHint');
    }
  });
});
