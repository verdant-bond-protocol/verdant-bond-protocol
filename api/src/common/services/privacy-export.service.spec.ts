import { PrivacyExportService, type ExportableProject } from './privacy-export.service';

const project: ExportableProject = { id: 1, name: 'Forest', status: 'approved', methodology: 'ARR', country: 'NG', metadataIpfsHash: 'secret-cid', ownerAddress: 'GOWNER', totalAreaHa: 10, carbonSequestrationEstimate: 42, createdAt: '2026-01-01T00:00:00.000Z' };

describe('PrivacyExportService', () => {
  it('removes owner-only fields for another authenticated viewer', () => {
    const exported = new PrivacyExportService().exportProject(project, 'GOTHER');
    expect(exported).not.toHaveProperty('metadataIpfsHash');
    expect(exported).not.toHaveProperty('ownerAddress');
  });

  it('keeps owner fields for the project owner', () => {
    expect(new PrivacyExportService().exportProject(project, 'GOWNER')).toMatchObject({ metadataIpfsHash: 'secret-cid', ownerAddress: 'GOWNER' });
  });
});
