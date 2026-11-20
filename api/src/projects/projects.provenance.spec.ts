import { ProjectsService } from './projects.service';
import { ProjectStatusEnum } from './interfaces/project.interface';

describe('ProjectsService provenance', () => {
  const project = {
    id: 1, name: 'Forest', status: ProjectStatusEnum.Pending, methodology: 'VCS', country: 'NG',
    metadataIpfsHash: 'QmMetadata', ownerAddress: 'GOWNER', totalAreaHa: 1,
    carbonSequestrationEstimate: 2, createdAt: '2026-01-01T00:00:00.000Z',
  };

  const service = new ProjectsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  beforeEach(() => jest.restoreAllMocks());

  it('represents a project with no downstream evidence as review-pending', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue(project);
    jest.spyOn(service, 'exportProject').mockResolvedValue({ reports: [], relatedBonds: [], documents: [] });
    const result = await service.getProvenance(1);
    expect(result.events.map((event) => event.status)).toEqual(['complete', 'pending']);
  });

  it('includes report, bond, and document references and marks missing report evidence stale', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue({ ...project, status: ProjectStatusEnum.Approved });
    jest.spyOn(service, 'exportProject').mockResolvedValue({
      reports: [{ id: 4, status: 'Verified' }], relatedBonds: [9], documents: ['QmDocument'],
    });
    const result = await service.getProvenance(1);
    expect(result.events.find((event) => event.type === 'report')?.status).toBe('stale');
    expect(result.events.find((event) => event.type === 'bond')?.reference).toBe('9');
    expect(result.events.find((event) => event.type === 'document')?.reference).toBe('QmDocument');
  });
});
