import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '../auth/rbac';
import { INestApplication, BadRequestException } from '@nestjs/common';
import * as request from 'supertest';
import * as crypto from 'crypto';
import { ProjectsService } from './projects.service';
import { BondsService } from '../bonds/bonds.service';
import { ProjectsController } from './projects.controller';
import { BondsController } from '../bonds/bonds.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { KycGuard } from '../common/guards/kyc.guard';

describe('Data Export Endpoints', () => {
  let app: INestApplication;
  let projectsService: jest.Mocked<ProjectsService>;
  let bondsService: jest.Mocked<BondsService>;

  const mockProjectsService = {
    exportProject: jest.fn(),
  };

  const mockBondsService = {
    exportBond: jest.fn(),
  };

  const mockJwtAuthGuard = {
    canActivate: (context: any) => {
      const req = context.switchToHttp().getRequest();
      // The bond export requires EXPORT_BOND (#228); an auditor's token carries it.
      req.user = {
        walletAddress: 'G_AUDITOR_ADDRESS_123',
        permissions: [Permission.EXPORT_BOND],
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController, BondsController],
      providers: [
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: BondsService, useValue: mockBondsService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtAuthGuard)
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(KycGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(IntentGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    projectsService = moduleRef.get(ProjectsService);
    bondsService = moduleRef.get(BondsService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /projects/:id/export', () => {
    it('returns a formatted project export with correct integrity checksum', async () => {
      const mockProjectPayload: any = {
        generationMetadata: {
          timestamp: new Date().toISOString(),
          exporterAddress: 'G_AUDITOR_ADDRESS_123',
          version: '1.0.0',
        },
        project: {
          id: 1,
          ownerAddress: 'G_OWNER',
          metadataIpfsHash: 'QmProjectMetadata',
          status: 1,
          methodology: 'VERRA-VCS',
          country: 'BR',
          name: 'Amazon Reforestation',
          totalAreaHa: 1000,
          carbonSequestrationEstimate: 50000,
        },
        documents: ['QmDoc1', 'QmDoc2'],
        reports: [],
        relatedBonds: [1],
      };

      // Calculate expected checksum
      const sortedData = JSON.stringify(mockProjectPayload, Object.keys(mockProjectPayload).sort());
      const expectedChecksum = crypto.createHash('sha256').update(sortedData).digest('hex');
      mockProjectPayload.generationMetadata.checksum = expectedChecksum;

      mockProjectsService.exportProject.mockResolvedValue(mockProjectPayload);

      await request(app.getHttpServer())
        .get('/projects/1/export')
        .expect(200)
        .expect((res) => {
          expect(res.body.project.id).toBe(1);
          expect(res.body.project.name).toBe('Amazon Reforestation');
          expect(res.body.documents).toEqual(['QmDoc1', 'QmDoc2']);
          expect(res.body.generationMetadata.checksum).toBe(expectedChecksum);
          
          // Verify checksum recalculation matches
          const receivedChecksum = res.body.generationMetadata.checksum;
          const receivedRest = JSON.parse(JSON.stringify(res.body));
          delete receivedRest.generationMetadata.checksum;
          const reSorted = JSON.stringify(receivedRest, Object.keys(receivedRest).sort());
          const reCalc = crypto.createHash('sha256').update(reSorted).digest('hex');
          expect(receivedChecksum).toBe(reCalc);
        });
    });

    it('returns HTTP 400 Bad Request if project is not found', async () => {
      mockProjectsService.exportProject.mockRejectedValue(new BadRequestException('Project not found'));

      await request(app.getHttpServer())
        .get('/projects/999/export')
        .expect(400);
    });
  });

  describe('GET /bonds/:id/export', () => {
    it('returns a formatted bond export with correct integrity checksum', async () => {
      const mockBondPayload: any = {
        generationMetadata: {
          timestamp: new Date().toISOString(),
          exporterAddress: 'G_AUDITOR_ADDRESS_123',
          version: '1.0.0',
        },
        bond: {
          id: 1,
          projectRegistryId: 'QmProjectMetadata',
          faceValue: '1000',
          couponSchedule: [1000000, 2000000],
          creditType: 'Carbon',
          maturityDate: 3000000,
          totalSupply: '10000',
          totalSubscribed: '5000',
          status: 0,
          createdAt: new Date().toISOString(),
        },
        lifecycleEvents: [{ event: 'ISSUED', timestamp: new Date().toISOString() }],
        holders: [{ address: 'G_HOLDER', balance: '1000' }],
        couponDistributions: [],
        retirements: [],
      };

      // Calculate expected checksum
      const sortedData = JSON.stringify(mockBondPayload, Object.keys(mockBondPayload).sort());
      const expectedChecksum = crypto.createHash('sha256').update(sortedData).digest('hex');
      mockBondPayload.generationMetadata.checksum = expectedChecksum;

      mockBondsService.exportBond.mockResolvedValue(mockBondPayload);

      await request(app.getHttpServer())
        .get('/bonds/1/export')
        .expect(200)
        .expect((res) => {
          expect(res.body.bond.id).toBe(1);
          expect(res.body.holders[0].address).toBe('G_HOLDER');
          expect(res.body.generationMetadata.checksum).toBe(expectedChecksum);

          // Verify checksum recalculation matches
          const receivedChecksum = res.body.generationMetadata.checksum;
          const receivedRest = JSON.parse(JSON.stringify(res.body));
          delete receivedRest.generationMetadata.checksum;
          const reSorted = JSON.stringify(receivedRest, Object.keys(receivedRest).sort());
          const reCalc = crypto.createHash('sha256').update(reSorted).digest('hex');
          expect(receivedChecksum).toBe(reCalc);
        });
    });

    it('returns HTTP 400 Bad Request if bond is not found', async () => {
      mockBondsService.exportBond.mockRejectedValue(new BadRequestException('Bond not found'));

      await request(app.getHttpServer())
        .get('/bonds/999/export')
        .expect(400);
    });
  });
});
