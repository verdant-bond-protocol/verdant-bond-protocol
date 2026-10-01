import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { buildControllerApp } from '../test/controller-guard.harness';
import { autoMock, TestRole } from '../test/guard-role-mocks';

describe('BondsController authorization (behavioral)', () => {
  let app: INestApplication;
  let bondsService: jest.Mocked<BondsService>;

  const mockBondsService = autoMock(BondsService);

  beforeAll(async () => {
    app = await buildControllerApp(BondsController, [
      { provide: BondsService, useValue: mockBondsService },
    ]);
    bondsService = app.get(BondsService) as jest.Mocked<BondsService>;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /bonds/:id/sweep-undistributed (admin-only)', () => {
    it('rejects anonymous callers before the service is touched', async () => {
      mockBondsService.sweepUndistributed.mockResolvedValue({} as any);
      await request(app.getHttpServer())
        .post('/bonds/1/sweep-undistributed')
        .set('x-test-role', 'anon' as TestRole)
        .expect(401);
      expect(bondsService.sweepUndistributed).not.toHaveBeenCalled();
    });

    it('rejects authenticated non-admin callers', async () => {
      await request(app.getHttpServer())
        .post('/bonds/1/sweep-undistributed')
        .set('x-test-role', 'user' as TestRole)
        .expect(403);
      expect(bondsService.sweepUndistributed).not.toHaveBeenCalled();
    });

    it('allows the admin key and reaches the service', async () => {
      mockBondsService.sweepUndistributed.mockResolvedValue({ id: 1 } as any);
      await request(app.getHttpServer())
        .post('/bonds/1/sweep-undistributed')
        .set('x-test-role', 'admin' as TestRole)
        .expect(200);
      expect(bondsService.sweepUndistributed).toHaveBeenCalledWith(1);
    });
  });

  describe('GET /bonds/:id/export (EXPORT_BOND)', () => {
    it('rejects anonymous callers', async () => {
      await request(app.getHttpServer())
        .get('/bonds/1/export')
        .set('x-test-role', 'anon' as TestRole)
        .expect(401);
      expect(bondsService.exportBond).not.toHaveBeenCalled();
    });

    it('rejects authenticated callers without the EXPORT_BOND permission', async () => {
      await request(app.getHttpServer())
        .get('/bonds/1/export')
        .set('x-test-role', 'user' as TestRole)
        .expect(403);
      expect(bondsService.exportBond).not.toHaveBeenCalled();
    });

    it('allows a caller holding EXPORT_BOND and forwards the wallet address', async () => {
      mockBondsService.exportBond.mockResolvedValue({ id: 1 } as any);
      await request(app.getHttpServer())
        .get('/bonds/1/export')
        .set('x-test-role', 'admin' as TestRole)
        .expect(200);
      expect(bondsService.exportBond).toHaveBeenCalledWith(1, 'G_ADMIN_ADDRESS');
    });
  });

  describe('POST /bonds (admin-only issuance)', () => {
    const body = { projectId: 'p', faceValue: 1, couponSchedule: [1], creditType: 'Carbon', maturityDate: 2, totalSupply: 1 };

    it('rejects anonymous callers before the service is touched', async () => {
      await request(app.getHttpServer())
        .post('/bonds')
        .set('x-test-role', 'anon' as TestRole)
        .send(body)
        .expect(401);
      expect(bondsService.create).not.toHaveBeenCalled();
    });

    it('rejects authenticated non-admin callers', async () => {
      await request(app.getHttpServer())
        .post('/bonds')
        .set('x-test-role', 'user' as TestRole)
        .send(body)
        .expect(403);
      expect(bondsService.create).not.toHaveBeenCalled();
    });

    it('allows the admin and reaches the service', async () => {
      mockBondsService.create.mockResolvedValue({ id: 1 } as any);
      await request(app.getHttpServer())
        .post('/bonds')
        .set('x-test-role', 'admin' as TestRole)
        .send(body)
        .expect(201);
      expect(bondsService.create).toHaveBeenCalled();
    });
  });
});
