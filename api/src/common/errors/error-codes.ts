export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  SETTLEMENT_FAILED = 'SETTLEMENT_FAILED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface ErrorMetadata {
  code: ErrorCode;
  retryable: boolean;
  safeMessage: string;
}

export const ErrorTaxonomy: Record<ErrorCode, Omit<ErrorMetadata, 'code'>> = {
  [ErrorCode.VALIDATION_FAILED]: {
    retryable: false,
    safeMessage: 'The provided data is invalid. Please check your input and try again.',
  },
  [ErrorCode.UNAUTHORIZED]: {
    retryable: false,
    safeMessage: 'Authentication is required. Please log in.',
  },
  [ErrorCode.FORBIDDEN]: {
    retryable: false,
    safeMessage: 'You do not have permission to perform this action.',
  },
  [ErrorCode.NOT_FOUND]: {
    retryable: false,
    safeMessage: 'The requested resource could not be found.',
  },
  [ErrorCode.INSUFFICIENT_BALANCE]: {
    retryable: false, // Usually requires external action (adding funds)
    safeMessage: 'Insufficient balance to complete the operation. Please add funds and try again.',
  },
  [ErrorCode.SETTLEMENT_FAILED]: {
    retryable: true,
    safeMessage: 'The settlement transaction failed on the network. You can safely retry.',
  },
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    retryable: true,
    safeMessage: 'Too many requests. Please wait a moment and try again.',
  },
  [ErrorCode.QUOTA_EXCEEDED]: {
    retryable: false,
    safeMessage: 'You have exceeded your usage quota for this operation.',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    retryable: false,
    safeMessage: 'An unexpected error occurred. Please contact support with your correlation ID.',
  },
};

export class DomainException extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: any,
  ) {
    super(ErrorTaxonomy[code].safeMessage);
  }
}
