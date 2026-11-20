import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class Rfc7807ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = 500;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();

      if (typeof exResponse === 'object' && exResponse !== null) {
        const resp = exResponse as Record<string, any>;
        title = resp.message || exception.message;
        detail = resp.detail || (typeof resp.message === 'string' ? resp.message : JSON.stringify(resp.message));
      } else {
        detail = String(exResponse);
      }
    }

    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : undefined;
    const responseObject = exceptionResponse !== null && typeof exceptionResponse === 'object'
      ? exceptionResponse as Record<string, unknown>
      : undefined;
    const code = String(responseObject?.code ?? `HTTP_${status}`);
    response.status(status).json({
      type: `https://errors.verdant-bond-protocol.org/${code.toLowerCase()}`,
      code,
      title,
      status,
      detail,
      instance: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
