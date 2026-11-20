import {
  createSignedManifest,
  verifyManifest,
  verifyManifestMatchesReport,
  DEFAULT_MANIFEST_SECRET,
} from './manifest';

describe('Evidence Manifest & Signature Verification (#113)', () => {
  const sampleInput = {
    project_id: 'VCS-1234',
    provider: 'SatelliteProcessor',
    methodology: 'REMOTE_SENSING',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    carbon_sequestered: 50000,
    confidence: 0.85,
    raw_observations: { scene_ids: ['scene-1', 'scene-2'], mean_ndvi: 0.65 },
    transformation_parameters: { area_ha: 1000, baseline_ndvi: 0.5, cloud_cover_max: 20 },
  };

  it('creates a valid signed manifest', () => {
    const manifest = createSignedManifest(sampleInput);
    expect(manifest.project_id).toBe('VCS-1234');
    expect(manifest.signature).toBeDefined();
    expect(typeof manifest.signature).toBe('string');
    
    const verification = verifyManifest(manifest);
    expect(verification.valid).toBe(true);
  });

  it('fails verification if manifest payload is tampered', () => {
    const manifest = createSignedManifest(sampleInput);
    const tampered = { ...manifest, carbon_sequestered: 999999 };
    
    const verification = verifyManifest(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain('Signature verification failed');
  });

  it('fails verification if wrong secret is used', () => {
    const manifest = createSignedManifest(sampleInput);
    const verification = verifyManifest(manifest, 'wrong-secret-key');
    expect(verification.valid).toBe(false);
  });

  it('verifies manifest matching report DTO values', () => {
    const manifest = createSignedManifest(sampleInput);
    const report = {
      project_id: 'VCS-1234',
      methodology: 'REMOTE_SENSING',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      carbon_sequestered: 50000,
    };

    const result = verifyManifestMatchesReport(manifest, report);
    expect(result.valid).toBe(true);
  });

  it('detects mismatch between manifest and report DTO values', () => {
    const manifest = createSignedManifest(sampleInput);

    expect(
      verifyManifestMatchesReport(manifest, {
        project_id: 'DIFFERENT-ID',
        methodology: 'REMOTE_SENSING',
        period_start: '2025-01-01',
        period_end: '2025-12-31',
        carbon_sequestered: 50000,
      }).valid,
    ).toBe(false);

    expect(
      verifyManifestMatchesReport(manifest, {
        project_id: 'VCS-1234',
        methodology: 'REMOTE_SENSING',
        period_start: '2025-01-01',
        period_end: '2025-12-31',
        carbon_sequestered: 1000,
      }).valid,
    ).toBe(false);
  });
});
