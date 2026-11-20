import { BadRequestException } from '@nestjs/common';
import { Rfc7807ExceptionFilter } from './rfc7807-exception.filter';

describe('Rfc7807ExceptionFilter', () => {
  it('preserves a stable application error code', () => {
    const json = jest.fn();
    const response = { status: jest.fn().mockReturnValue({ json }) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: '/projects' }),
      }),
    } as any;

    new Rfc7807ExceptionFilter().catch(
      new BadRequestException({ code: 'VALIDATION_ERROR', message: 'invalid project' }),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      type: 'https://errors.verdant-bond-protocol.org/validation_error',
    }));
  });
});
