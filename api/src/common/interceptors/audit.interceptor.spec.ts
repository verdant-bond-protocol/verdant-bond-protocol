import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from '../../audit/audit.service';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let auditService: jest.Mocked<AuditService>;

  beforeEach(() => {
    auditService = {
      record: jest.fn().mockResolvedValue({ record: { hash: '123' } }),
    } as any;
    interceptor = new AuditInterceptor(auditService);
  });

  it('should log sensitive actions and mask secrets', (done) => {
    const mockRequest = {
      method: 'POST',
      url: '/api/v1/bonds',
      user: { sub: 'admin-user' },
      body: { title: 'Green Bond', password: 'secret-password' },
    };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as ExecutionContext;

    const mockCallHandler = {
      handle: () => of('success'),
    } as CallHandler;

    interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
      expect(auditService.record).toHaveBeenCalledWith({
        entityType: 'http_request',
        entityId: '/api/v1/bonds',
        principal: 'admin-user',
        action: 'POST',
        payload: JSON.stringify({ title: 'Green Bond' }), // password should be stripped
      });
      done();
    });
  });

  it('should ignore GET requests', (done) => {
    const mockRequest = {
      method: 'GET',
      url: '/api/v1/bonds',
    };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as ExecutionContext;

    const mockCallHandler = {
      handle: () => of('success'),
    } as CallHandler;

    interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
      expect(auditService.record).not.toHaveBeenCalled();
      done();
    });
  });
});
