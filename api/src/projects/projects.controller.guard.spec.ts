import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { buildControllerApp } from '../test/controller-guard.harness';
import { autoMock, TestRole } from '../test/guard-role-mocks';

describe('ProjectsController authorization (behavioral)', () => {
  let app: INestApplication;
  let projectsService: jest.Mocked<ProjectsService>;

  const mockProjectsService = autoMock(ProjectsService);

  beforeAll(async () => {
    app = await buildControllerApp(ProjectsController, [
      { provide: ProjectsService, useValue: mockProjectsService },
    ]);
    projectsService = app.get(ProjectsService) as jest.Mocked<ProjectsService>;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /projects/:id/export (authenticated)', () => {
    it('rejects anonymous callers', async () => {
      await request(app.getHttpServer())
        .get('/projects/1/export')
        .set('x-test-role', 'anon' as TestRole)
        .expect(401);
      expect(projectsService.exportProject).not.toHaveBeenCalled();
    });

    it('allows authenticated callers and forwards the auditor address', async () => {
      mockProjectsService.exportProject.mockResolvedValue({ id: 1 } as any);
      await request(app.getHttpServer())
        .get('/projects/1/export')
        .set('x-test-role', 'user' as TestRole)
        .expect(200);
      expect(projectsService.exportProject).toHaveBeenCalledWith(1, 'G_USER_ADDRESS');
    });
  });

  describe('POST /projects (public mutation)', () => {
    it('reaches the service for anonymous callers', async () => {
      mockProjectsService.register.mockResolvedValue({ id: 1 } as any);
      await request(app.getHttpServer())
        .post('/projects')
        .set('x-test-role', 'anon' as TestRole)
        .send({ name: 'p', country: 'BR', methodology: 'VCS', totalAreaHa: 1, carbonSequestrationEstimate: 1 })
        .expect(201);
      expect(projectsService.register).toHaveBeenCalled();
    });
  });
});
