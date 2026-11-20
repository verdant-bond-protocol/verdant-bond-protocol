import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, remediationFor, ErrorTaxonomy } from './error-codes';

export interface ApiProblemContext {
  [key: string]: unknown;
}

/**
 * An HTTP exception that carries a stable taxonomy `code`, an optional
 * client-safe `detail`, an explicit `remediation`, and a non-sensitive
 * `context` payload (#376). The global `Rfc7807ExceptionFilter` renders these
 * fields directly into the RFC 7807 response.
 */
export class ApiProblemException extends HttpException {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly remediation: string;
  readonly context?: ApiProblemContext;

  constructor(
    code: ErrorCode,
    options: {
      status?: number;
      detail?: string;
      remediation?: string;
      context?: ApiProblemContext;
    } = {},
  ) {
    const status = options.status ?? HttpStatus.BAD_REQUEST;
    const detail = options.detail ?? ErrorTaxonomy[code]?.safeMessage ?? 'Request failed';
    super({ code, detail, remediation: options.remediation ?? remediationFor(code), context: options.context }, status);
    this.code = code;
    this.detail = detail;
    this.remediation = options.remediation ?? remediationFor(code);
    this.context = options.context;
  }
}
