import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../errors/error-codes';
import { ApiProblemException } from '../errors/problem-exception';
import { RISK_SCORED_KEY, RiskScoredOptions } from './risk.decorator';
import { RiskService } from './risk.service';
import { RiskAssessment } from './risk.types';

/** Body fields inspected (in order) to derive the notional amount. */
const DEFAULT_AMOUNT_FIELDS = [
  'amountUsd',
  'amount',
  'quoteAmount',
  'faceValue',
  'totalSupply',
  'pricePerToken',
  'size',
  'quantity',
];

export const RISK_STEP_UP_HEADER = 'x-risk-step-up-token';

/**
 * Scores opted-in high-impact operations and enforces the resulting action
 * (#375):
 *   - low risk  → allowed and annotated with `x-risk-score`;
 *   - elevated  → requires `x-risk-step-up-token`, otherwise 401 STEP_UP_REQUIRED;
 *   - high risk → 403 RISK_REVIEW_REQUIRED and recorded for the next attempt.
 *
 * Endpoints without `@RiskScored` are untouched, so legitimate low-risk traffic
 * keeps working exactly as before.
 */
@Injectable()
export class RiskGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly riskService: RiskService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RiskScoredOptions | undefined>(RISK_SCORED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options || !this.riskService.isEnabled()) return true;

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const actor = this.resolveActor(request);
    const amountUsd = this.resolveAmount(request, options.amountFields);
    const ip = this.resolveIp(request);

    const assessment = this.riskService.assess({
      operation: options.operation,
      actor,
      amountUsd,
      kycVerified: this.isKycVerified(request),
      ip,
    });

    request.risk = assessment;
    response?.setHeader?.('x-risk-score', String(assessment.score));
    response?.setHeader?.('x-risk-band', assessment.band);

    if (assessment.action === 'allow') return true;

    if (assessment.action === 'step_up') {
      const token = this.header(request, RISK_STEP_UP_HEADER);
      if (token) {
        response?.setHeader?.('x-risk-step-up', 'satisfied');
        return true;
      }
      throw new ApiProblemException(ErrorCode.STEP_UP_REQUIRED, {
        status: 401,
        detail: 'Additional verification is required for this operation.',
        context: this.context(assessment),
      });
    }

    // high risk → refuse and remember, so a repeated attempt escalates faster.
    this.riskService.recordRejection(actor);
    throw new ApiProblemException(ErrorCode.RISK_REVIEW_REQUIRED, {
      status: 403,
      context: this.context(assessment),
    });
  }

  private context(assessment: RiskAssessment): Record<string, unknown> {
    return {
      score: assessment.score,
      band: assessment.band,
      action: assessment.action,
      reasons: assessment.reasons.map((reason) => reason.signal),
    };
  }

  private resolveActor(request: any): string {
    return (
      request.user?.walletAddress ||
      this.header(request, 'x-wallet-address') ||
      request.ip ||
      request.socket?.remoteAddress ||
      'anonymous'
    );
  }

  private isKycVerified(request: any): boolean {
    const status = request.user?.kycStatus;
    return status === 'verified' || status === 'accredited';
  }

  private resolveAmount(request: any, fields?: string[]): number {
    const body = request.body ?? {};
    for (const field of fields ?? DEFAULT_AMOUNT_FIELDS) {
      const value = Number(body[field]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  private resolveIp(request: any): string | undefined {
    const forwarded = this.header(request, 'x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    return request.ip;
  }

  private header(request: any, name: string): string | undefined {
    const value = request.headers?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
