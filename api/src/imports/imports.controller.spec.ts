import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { ImportPipelineError, ImportPipelineService } from './import-pipeline.service';
import { ImportsController } from './imports.controller';

const req = { user: { walletAddress: 'GADMIN' } } as unknown as AuthenticatedRequest;

describe('ImportsController', () => {
  let service: jest.Mocked<Pick<ImportPipelineService, 'preview' | 'commit' | 'rollback' | 'get' | 'traceForKey'>>;
  let controller: ImportsController;

  beforeEach(() => {
    service = {
      preview: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      get: jest.fn(),
      traceForKey: jest.fn(),
    };
    controller = new ImportsController(service as unknown as ImportPipelineService);
  });

  it('is admin-only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ImportsController)).toEqual([JwtAuthGuard, AdminGuard]);
  });

  it('takes the actor from the token, never from the body', async () => {
    await controller.preview('kyc_attestation', { rows: [], actor: 'GSPOOF' } as never, req);
    expect(service.preview).toHaveBeenCalledWith(expect.objectContaining({ actor: 'GADMIN', format: 'json' }));
    await controller.commit('b1', { previewHash: 'h', actor: 'GSPOOF' } as never, req);
    expect(service.commit).toHaveBeenCalledWith('b1', { previewHash: 'h', allowDuplicate: false, actor: 'GADMIN' });
  });

  it('infers csv format when a csv string is sent', async () => {
    await controller.preview('kyc_attestation', { csv: 'address\n' }, req);
    expect(service.preview).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', csv: 'address\n' }));
  });

  it('requires a key for trace lookups', async () => {
    await expect(controller.trace(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['NOT_FOUND', NotFoundException],
    ['INVALID_REQUEST', BadRequestException],
    ['PREVIEW_EXPIRED', GoneException],
    ['DISABLED', ServiceUnavailableException],
    ['CAPACITY', ServiceUnavailableException],
    ['PREVIEW_MISMATCH', ConflictException],
    ['INVALID_STATE', ConflictException],
    ['DUPLICATE_IMPORT', ConflictException],
  ] as const)('maps %s to %p', async (code, exception) => {
    service.commit.mockRejectedValue(new ImportPipelineError(code, 'nope'));
    await expect(controller.commit('b1', { previewHash: 'h' }, req)).rejects.toBeInstanceOf(exception);
  });

  it('lets unexpected errors through unchanged', async () => {
    const boom = new Error('boom');
    service.rollback.mockRejectedValue(boom);
    await expect(controller.rollback('b1', { previewHash: 'h' }, req)).rejects.toBe(boom);
  });
});
