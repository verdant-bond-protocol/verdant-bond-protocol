import {
  normalizeMethodology,
  assessCrossSourceAnomaly,
  assessCrossSourceAnomalies,
  groupAndAssess,
  METHODOLOGY_TOLERANCE,
} from './anomaly';

describe('normalizeMethodology', () => {
  it('maps registry methodology strings to their family', () => {
    expect(normalizeMethodology('VERRA-VCS')).toBe('VERRA-VCS');
    expect(normalizeMethodology('Verra Vcs v1.3')).toBe('VERRA-VCS');
    expect(normalizeMethodology('verra-vcs')).toBe('VERRA-VCS');
  });

  it('maps remote sensing variants to REMOTE-SENSING', () => {
    expect(normalizeMethodology('REMOTE-SENSING')).toBe('REMOTE-SENSING');
    expect(normalizeMethodology('Satellite analysis')).toBe('REMOTE-SENSING');
  });

  it('maps IoT sensor variants to IOT-SENSORS', () => {
    expect(normalizeMethodology('IOT-SENSORS')).toBe('IOT-SENSORS');
    expect(normalizeMethodology('IOT network')).toBe('IOT-SENSORS');
  });

  it('maps blue-carbon variants to BLUE-CARBON', () => {
    expect(normalizeMethodology('BLUE-CARBON')).toBe('BLUE-CARBON');
    expect(normalizeMethodology('Mangrove monitoring')).toBe('BLUE-CARBON');
  });

  it('falls back to UNKNOWN for unrecognized or empty methodologies', () => {
    expect(normalizeMethodology('mystery-method')).toBe('UNKNOWN');
    expect(normalizeMethodology('')).toBe('UNKNOWN');
    expect(normalizeMethodology(null)).toBe('UNKNOWN');
  });
});

describe('assessCrossSourceAnomaly (#158)', () => {
  it('reports missing_source when fewer than two sources exist', () => {
    const result = assessCrossSourceAnomaly({
      projectId: 'VCS-1',
      periodKey: '100-200',
      values: [{ sourceId: 'registry', methodology: 'VERRA-VCS', carbon: 1000 }],
    });
    expect(result.kind).toBe('missing_source');
    expect(result.severity).toBe('info');
    expect(result.median).toBeNull();
  });

  it('returns normal when every source agrees within tolerance', () => {
    const tolerance = METHODOLOGY_TOLERANCE['VERRA-VCS'];
    const result = assessCrossSourceAnomaly({
      projectId: 'VCS-2',
      periodKey: '100-200',
      values: [
        { sourceId: 'registry', methodology: 'VERRA-VCS', carbon: 1000 },
        { sourceId: 'iot', methodology: 'VERRA-VCS', carbon: 1000 * (1 + tolerance * 0.5) },
      ],
    });
    expect(result.kind).toBe('normal');
    expect(result.severity).toBe('info');
    expect(result.median).toBeCloseTo(1000 * (1 + tolerance * 0.25));
  });

  it('flags a single deviating source as an outlier', () => {
    const result = assessCrossSourceAnomaly({
      projectId: 'VCS-3',
      periodKey: '100-200',
      values: [
        { sourceId: 'registry', methodology: 'VERRA-VCS', carbon: 1000 },
        { sourceId: 'registry2', methodology: 'VERRA-VCS', carbon: 950 },
        { sourceId: 'registry3', methodology: 'VERRA-VCS', carbon: 1050 },
        { sourceId: 'satellite', methodology: 'REMOTE-SENSING', carbon: 1300 },
      ],
    });
    expect(result.kind).toBe('outlier');
    expect(result.severity).toBe('warning');
    expect(result.reason).toContain('satellite');
  });

  it('flags two disagreeing sources as conflicting_sources', () => {
    const result = assessCrossSourceAnomaly({
      projectId: 'VCS-4',
      periodKey: '100-200',
      values: [
        { sourceId: 'registry', methodology: 'VERRA-VCS', carbon: 1000 },
        { sourceId: 'registry2', methodology: 'VERRA-VCS', carbon: 1000 },
        { sourceId: 'other', methodology: 'VERRA-VCS', carbon: 100 },
        { sourceId: 'other2', methodology: 'VERRA-VCS', carbon: 100 },
      ],
    });
    expect(result.kind).toBe('conflicting_sources');
    expect(result.severity).toBe('critical');
  });

  it('escalates severity to critical when deviation exceeds 2x tolerance', () => {
    const result = assessCrossSourceAnomaly({
      projectId: 'VCS-5',
      periodKey: '100-200',
      values: [
        { sourceId: 'registry', methodology: 'IOT-SENSORS', carbon: 1000 },
        { sourceId: 'registry2', methodology: 'IOT-SENSORS', carbon: 950 },
        { sourceId: 'iot', methodology: 'IOT-SENSORS', carbon: 1000 * 4 },
      ],
    });
    expect(result.kind).toBe('outlier');
    expect(result.severity).toBe('critical');
  });
});

describe('assessCrossSourceAnomalies / groupAndAssess', () => {
  it('assesses each pre-grouped project-period', () => {
    const assessments = assessCrossSourceAnomalies([
      {
        projectId: 'VCS-1',
        periodKey: '100-200',
        values: [{ sourceId: 'a', carbon: 1 }],
      },
    ]);
    expect(assessments[0].kind).toBe('missing_source');
  });

  it('groups flat reports and assesses each project-period cluster', () => {
    const assessments = groupAndAssess([
      {
        projectId: 'VCS-1',
        periodStart: 100,
        periodEnd: 200,
        sourceId: 'registry',
        methodology: 'VERRA-VCS',
        carbon: 1000,
      },
      {
        projectId: 'VCS-1',
        periodStart: 100,
        periodEnd: 200,
        sourceId: 'iot',
        methodology: 'VERRA-VCS',
        carbon: 1090,
      },
      {
        projectId: 'VCS-1',
        periodStart: 300,
        periodEnd: 400,
        sourceId: 'registry',
        methodology: 'VERRA-VCS',
        carbon: 900,
      },
    ]);

    expect(assessments).toHaveLength(2);
    const first = assessments.find((a) => a.periodKey === '100-200');
    const second = assessments.find((a) => a.periodKey === '300-400');
    expect(first!.kind).toBe('normal');
    expect(second!.kind).toBe('missing_source');
  });
});
