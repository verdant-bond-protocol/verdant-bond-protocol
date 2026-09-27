import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ContractException } from '../../stellar/contract-errors';
import { ErrorCode, ErrorTaxonomy, DomainException } from '../errors/error-codes';

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
  errors?: Array<{ field: string; message: string }>;
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
    let retryable = false;

    if (exception instanceof DomainException) {
      status = 400;
      code = exception.code;
      title = exception.code.replace(/_/g, ' ');
      detail = exception.message;
      retryable = ErrorTaxonomy[exception.code].retryable;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      const mappedCode = defaultCode(status);

      if (typeof exResponse === 'object' && exResponse !== null) {
        const resp = exResponse as Record<string, any>;
        errors = validationErrors(resp.message);
        title = resp.error || (exception instanceof BadRequestException ? 'Bad Request' : exception.message);
      } else {
        title = exception.message;
      }
      
      code = mappedCode;
      detail = ErrorTaxonomy[mappedCode]?.safeMessage || 'An unexpected error occurred.';
      retryable = ErrorTaxonomy[mappedCode]?.retryable || false;

      if (exception instanceof ContractException) {
        title = 'Contract Error';
        code = ErrorCode.SETTLEMENT_FAILED;
        detail = ErrorTaxonomy[ErrorCode.SETTLEMENT_FAILED].safeMessage;
        retryable = ErrorTaxonomy[ErrorCode.SETTLEMENT_FAILED].retryable;
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
    }

    const problem: ProblemDetail = {
      type: `https://errors.verdant-bond-protocol.org/${code}`,
      title,
      status,
      detail,
      code,
      instance: request.url,
      correlationId: (request as any).correlationId || (request as any).requestId,
      timestamp: new Date().toISOString(),
      retryable,
    };
    if (errors) problem.errors = errors;
    if (contract) problem.contract = contract;

    if (problem.correlationId) {
      response.setHeader('x-correlation-id', problem.correlationId);
    }
    response.status(status).json(problem);
  }
}
