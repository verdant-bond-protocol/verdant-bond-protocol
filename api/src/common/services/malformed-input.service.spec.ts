import { PrivacyExportService, type ExportableProject } from './privacy-export.service';

describe('malformed and boundary input coverage', () => {
  it('does not leak owner-only fields for arbitrary viewer strings', () => {
    const service = new PrivacyExportService();
    const project = { id: 1, name: 'x'.repeat(256), status: 'pending', methodology: '', country: 'NG', metadataIpfsHash: 'private', ownerAddress: 'OWNER', totalAreaHa: 0, carbonSequestrationEstimate: Number.MAX_SAFE_INTEGER, createdAt: '' } satisfies ExportableProject;
    for (const viewer of ['', ' ', '\0', 'OWNER\n', 'x'.repeat(4096)]) {
      if (!viewer) expect(() => service.exportProject(project, viewer)).toThrow();
      else expect(service.exportProject(project, viewer)).not.toHaveProperty('metadataIpfsHash');
    }
  });
});
