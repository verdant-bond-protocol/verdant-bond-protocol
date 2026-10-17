import { ExecutionContext } from '@nestjs/common';
import { RISK_STEP_UP_HEADER, RiskGuard } from './risk.guard';
import { RiskService } from './risk.service';
import { ErrorCode } from '../errors/error-codes';
import { ApiProblemException } from '../errors/problem-exception';

function makeContext(options: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  user?: Record<string, unknown>;
  ip?: string;
}) {
  const request: any = {
    body: options.body ?? {},
    headers: options.headers ?? {},
    user: options.user,
    ip: options.ip,
  };
  const setHeader = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

function makeGuard(metadata: unknown, service: RiskService) {
  const reflector = { get: jest.fn(() => metadata) } as any;
  return new RiskGuard(reflector, service);
}

function captureError(fn: () => unknown): ApiProblemException {
  try {
    fn();
  } catch (error) {
    return error as ApiProblemException;
  }
  throw new Error('expected function to throw');
}

describe('RiskGuard (#375)', () => {
  let service: RiskService;

  beforeEach(() => {
    service = new RiskService();
    service.configure({ enabled: true });
  });

  it('ignores endpoints without @RiskScored metadata', () => {
    const guard = makeGuard(undefined, service);
    const { context } = makeContext({});

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a low-risk verified operation and annotates the response', () => {
    const guard = makeGuard({ operation: 'marketplace.buy', amountFields: ['amount'] }, service);
    const { context, setHeader } = makeContext({
      body: { amount: 100 },
      user: { kycVerified: true },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(setHeader).toHaveBeenCalledWith('x-risk-score', expect.any(String));
    expect(setHeader).toHaveBeenCalledWith('x-risk-band', 'low');
  });

  it('requires step-up for an elevated operation without a token', () => {
    const guard = makeGuard({ operation: 'bond.issue', amountFields: ['faceValue'] }, service);
    const { context } = makeContext({ body: { faceValue: 50_000 } });

    const error = captureError(() => guard.canActivate(context));

    expect(error.getStatus()).toBe(401);
    expect(error.code).toBe(ErrorCode.STEP_UP_REQUIRED);
  });

  it('lets an elevated operation proceed when the step-up token is present', () => {
    const guard = makeGuard({ operation: 'bond.issue', amountFields: ['faceValue'] }, service);
    const { context, setHeader } = makeContext({
      body: { faceValue: 50_000 },
      headers: { [RISK_STEP_UP_HEADER]: 'proof-token' },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(setHeader).toHaveBeenCalledWith('x-risk-step-up', 'satisfied');
  });

  it('refuses high-risk operations for review', () => {
    service.configure({ reviewThreshold: 60 });
    const guard = makeGuard({ operation: 'settlement.redeem', amountFields: ['amount'] }, service);
    const { context } = makeContext({ body: { amount: 150_000 } });

    const error = captureError(() => guard.canActivate(context));

    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe(ErrorCode.RISK_REVIEW_REQUIRED);
  });

  it('exposes the risk score on the request for downstream audit', () => {
    const guard = makeGuard({ operation: 'marketplace.buy' }, service);
    const { context } = makeContext({ user: { kycVerified: true } });

    guard.canActivate(context);

    const request = context.switchToHttp().getRequest() as any;
    expect(request.risk).toBeDefined();
    expect(typeof request.risk.score).toBe('number');
  });
});
