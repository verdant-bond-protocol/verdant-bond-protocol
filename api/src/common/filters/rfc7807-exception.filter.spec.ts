import { BadRequestException, UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { Rfc7807ExceptionFilter } from './rfc7807-exception.filter';
import { ContractException, StableErrorCode } from '../../stellar/contract-errors';
import { ErrorCode, ErrorTaxonomy, DomainException } from '../errors/error-codes';

function makeHost(exceptionPath = '/api/test') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const response = { status, setHeader: jest.fn() };
  const request = { url: exceptionPath, correlationId: 'corr-123' };
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  };
  return { host, status, json };
}

describe('Rfc7807ExceptionFilter', () => {
  it('normalizes validation failures with safe messages and correlation id', () => {
    const { host, status, json } = makeHost();
    const filter = new Rfc7807ExceptionFilter();

    filter.catch(new BadRequestException(['address must be a Stellar public key']), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: `https://errors.verdant-bond-protocol.org/${ErrorCode.VALIDATION_FAILED}`,
        status: 400,
        code: ErrorCode.VALIDATION_FAILED,
        detail: ErrorTaxonomy[ErrorCode.VALIDATION_FAILED].safeMessage,
        correlationId: 'corr-123',
        retryable: false,
        errors: [{ field: 'address', message: 'address must be a Stellar public key' }],
      }),
    );
  });

  it('handles authorization failures safely', () => {
    const { host, status, json } = makeHost();
    const filter = new Rfc7807ExceptionFilter();

    filter.catch(new UnauthorizedException('Token expired or invalid'), host);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.UNAUTHORIZED,
        detail: ErrorTaxonomy[ErrorCode.UNAUTHORIZED].safeMessage,
        retryable: false,
      }),
    );
  });

  it('includes safe contract context and settlement failure code for contract exceptions', () => {
    const { host, status, json } = makeHost('/api/marketplace/buy');
    const filter = new Rfc7807ExceptionFilter();

    filter.catch(
      new ContractException(
        StableErrorCode.DEX_ORDER_ALREADY_FILLED,
        'Marketplace order is already filled',
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        'buy_order',
        5,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Contract Error',
        code: ErrorCode.SETTLEMENT_FAILED,
        detail: ErrorTaxonomy[ErrorCode.SETTLEMENT_FAILED].safeMessage,
        retryable: true,
        contract: {
          address: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          method: 'buy_order',
          rawErrorCode: 5,
        },
      }),
    );
  });

  it('handles unexpected catch-all errors cleanly', () => {
    const { host, status, json } = makeHost();
    const filter = new Rfc7807ExceptionFilter();

    filter.catch(new InternalServerErrorException('Database disconnected unexpectedly'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.INTERNAL_ERROR,
        detail: ErrorTaxonomy[ErrorCode.INTERNAL_ERROR].safeMessage,
        retryable: false,
        correlationId: 'corr-123',
      }),
    );
    // Ensure sensitive details are not leaked
    const jsonCall = json.mock.calls[0][0];
    expect(jsonCall.detail).not.toContain('Database');
  });

  it('handles custom domain exceptions cleanly', () => {
    const { host, status, json } = makeHost();
    const filter = new Rfc7807ExceptionFilter();

    filter.catch(new DomainException(ErrorCode.INSUFFICIENT_BALANCE), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.INSUFFICIENT_BALANCE,
        detail: ErrorTaxonomy[ErrorCode.INSUFFICIENT_BALANCE].safeMessage,
        retryable: false,
      }),
    );
  });
});
