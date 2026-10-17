import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ContractException } from '../../stellar/contract-errors';
import { ErrorCode, ErrorTaxonomy, DomainException, problemTypeUri, remediationFor } from '../errors/error-codes';
import { ApiProblemException } from '../errors/problem-exception';

type ProblemDetail = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance: string;
  correlationId?: string;
  timestamp: string;
  retryable: boolean;
  remediation: string;
  errors?: Array<{ field: string; message: string }>;
  context?: Record<string, unknown>;
  contract?: {
    address?: string;
    method?: string;
    rawErrorCode?: number;
  };
};

function validationErrors(message: unknown): Array<{ field: string; message: string }> | undefined {
  if (!Array.isArray(message)) return undefined;
  return message.map((item) => {
    if (typeof item === 'string') {
      const field = item.split(' ')[0] || 'request';
      return { field, message: item };
    }
    return { field: 'request', message: String(item) };
  });
}

function defaultCode(status: number): ErrorCode {
  if (status === 400) return ErrorCode.VALIDATION_FAILED;
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMIT_EXCEEDED;
  return ErrorCode.INTERNAL_ERROR;
}

@Catch()
export class Rfc7807ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = 500;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred';
    let code: string = ErrorCode.INTERNAL_ERROR;
    let errors: ProblemDetail['errors'];
    let contract: ProblemDetail['contract'];
    let retryable = false;
    let retryAfterSeconds: number | undefined;
    let remediation = remediationFor(ErrorCode.INTERNAL_ERROR);
    let context: Record<string, unknown> | undefined;

    if (exception instanceof DomainException) {
      status = 400;
      code = exception.code;
      title = exception.code.replace(/_/g, ' ');
      detail = exception.message;
      retryable = ErrorTaxonomy[exception.code].retryable;
      remediation = remediationFor(exception.code);
    } else if (exception instanceof ApiProblemException) {
      status = exception.getStatus();
      code = exception.code;
      title = exception.code.replace(/_/g, ' ');
      detail = exception.detail;
      retryable = ErrorTaxonomy[exception.code]?.retryable ?? false;
      remediation = exception.remediation;
      context = exception.context;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      let mappedCode = defaultCode(status);

      if (typeof exResponse === 'object' && exResponse !== null) {
        const resp = exResponse as Record<string, any>;
        errors = validationErrors(resp.message);
        title = resp.error || (exception instanceof BadRequestException ? 'Bad Request' : exception.message);
        // An exception may name its own stable code (e.g. QUEUE_BACKPRESSURE,
        // #391); unknown codes fall back to the status-derived default.
        if (typeof resp.code === 'string' && resp.code in ErrorTaxonomy) {
          mappedCode = resp.code as ErrorCode;
        }
        if (Number.isInteger(resp.retryAfterSeconds) && resp.retryAfterSeconds > 0) {
          retryAfterSeconds = resp.retryAfterSeconds;
        }
      } else {
        title = exception.message;
      }
      
      code = mappedCode;
      detail = ErrorTaxonomy[mappedCode]?.safeMessage || 'An unexpected error occurred.';
      retryable = ErrorTaxonomy[mappedCode]?.retryable || false;
      remediation = remediationFor(mappedCode);

      if (exception instanceof ContractException) {
        title = 'Contract Error';
        code = ErrorCode.SETTLEMENT_FAILED;
        detail = ErrorTaxonomy[ErrorCode.SETTLEMENT_FAILED].safeMessage;
        retryable = ErrorTaxonomy[ErrorCode.SETTLEMENT_FAILED].retryable;
        remediation = remediationFor(ErrorCode.SETTLEMENT_FAILED);
        contract = {
          address: exception.contractAddress,
          method: exception.method,
          rawErrorCode: exception.rawErrorCode,
        };
      }
    } else {
      code = ErrorCode.INTERNAL_ERROR;
      detail = ErrorTaxonomy[ErrorCode.INTERNAL_ERROR].safeMessage;
      retryable = ErrorTaxonomy[ErrorCode.INTERNAL_ERROR].retryable;
      remediation = remediationFor(ErrorCode.INTERNAL_ERROR);
    }

    const problem: ProblemDetail = {
      type: problemTypeUri(code as ErrorCode),
      title,
      status,
      detail,
      code,
      instance: request.url,
      correlationId: (request as any).correlationId || (request as any).requestId,
      timestamp: new Date().toISOString(),
      retryable,
      remediation,
    };
    if (errors) problem.errors = errors;
    if (context) problem.context = context;
    if (contract) problem.contract = contract;

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }
    if (problem.correlationId) {
      response.setHeader('x-correlation-id', problem.correlationId);
    }
    response.status(status).json(problem);
  }
}
