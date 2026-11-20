import {
  pollVerraProject,
  fetchVerraProject,
  verifyVerraReport,
  VerraNotFoundError,
  VerraSchemaError,
  VerraNoVerifiedReportsError,
  VerraAdapterError,
} from './verra-adapter';
import { MockHttpClient } from './test-helpers';

const BASE_URL = 'https://registry.verra.org/api/v1';
const PERIOD = { periodStart: '2025-01-01', periodEnd: '2025-03-31' };

const PROJECT = {
  project_id: 'VCS-1234',
  name: 'Loreto Reforestation Corridor',
  registry: 'VERRA_VCS',
  status: 'ACTIVE',
  methodologies: ['VERRA_VCS'],
};

const REPORT = {
  report_id: 'MR-2024-0112',
  verification_status: 'VERIFIED',
  verification_date: '2025-02-10',
  reporting_period_start: '2025-01-01',
  reporting_period_end: '2025-03-31',
  methodology: 'VERRA_VCS',
  carbon_sequestered_kg: 50000,
  credits_issued: 50,
};

describe('pollVerraProject', () => {
  it('produces a validated report with evidence hash for verified reports', async () => {
    const http = new MockHttpClient([
      { status: 200, data: PROJECT },
      { status: 200, data: { reports: [REPORT] } },
    ]);

    const report = await pollVerraProject('VCS-1234', PERIOD, { baseUrl: BASE_URL, http });

    expect(report.project_id).toBe('VCS-1234');
    expect(report.period_start).toBe('2025-01-01');
    expect(report.period_end).toBe('2025-03-31');
    expect(report.carbon_sequestered).toBe(50000);
    expect(report.methodology).toBe('VERRA_VCS');
    expect(report.ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(report.evidence.verra_report_ids).toEqual(['MR-2024-0112']);
    expect(http.calls).toHaveLength(2);
  });

  it('sums carbon across multiple verified reports in the period', async () => {
    const http = new MockHttpClient([
      { status: 200, data: PROJECT },
      {
        status: 200,
        data: {
          reports: [
            { ...REPORT, carbon_sequestered_kg: 10000 },
            { ...REPORT, report_id: 'MR-2', carbon_sequestered_kg: 20000 },
            { ...REPORT, report_id: 'MR-3', verification_status: 'PENDING' },
          ],
        },
      },
    ]);

    const report = await pollVerraProject('VCS-1234', PERIOD, { baseUrl: BASE_URL, http });
    expect(report.carbon_sequestered).toBe(30000);
    expect(report.evidence.verra_report_ids).toEqual(['MR-2024-0112', 'MR-2']);
  });

  it('throws VerraNotFoundError on a 404 project lookup', async () => {
    const http = new MockHttpClient([{ status: 404, data: {} }]);
    await expect(
      pollVerraProject('missing', PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(VerraNotFoundError);
  });

  it('throws VerraSchemaError when the project payload violates the schema', async () => {
    const http = new MockHttpClient([{ status: 200, data: { project_id: 123 } }]);
    await expect(
      pollVerraProject('VCS-1234', PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(VerraSchemaError);
  });

  it('throws VerraSchemaError when the report list payload violates the schema', async () => {
    const http = new MockHttpClient([
      { status: 200, data: PROJECT },
      { status: 200, data: { reports: [{ report_id: 'x', verification_status: 'VERIFIED' }] } },
    ]);
    await expect(
      pollVerraProject('VCS-1234', PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(VerraSchemaError);
  });

  it('throws VerraNoVerifiedReportsError when no verified reports cover the period', async () => {
    const http = new MockHttpClient([
      { status: 200, data: PROJECT },
      { status: 200, data: { reports: [{ ...REPORT, verification_status: 'REJECTED' }] } },
    ]);
    await expect(
      pollVerraProject('VCS-1234', PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(VerraNoVerifiedReportsError);
  });

  it('throws VerraAdapterError on a non-2xx registry response', async () => {
    const http = new MockHttpClient([
      { status: 500, data: { error: 'boom' } },
    ]);
    await expect(
      pollVerraProject('VCS-1234', PERIOD, { baseUrl: BASE_URL, http }),
    ).rejects.toBeInstanceOf(VerraAdapterError);
  });
});

describe('fetchVerraProject', () => {
  it('validates and normalizes a project record', async () => {
    const http = new MockHttpClient([{ status: 200, data: PROJECT }]);
    const project = await fetchVerraProject('VCS-1234', { baseUrl: BASE_URL, http });
    expect(project.name).toBe('Loreto Reforestation Corridor');
    expect(project.status).toBe('ACTIVE');
  });
});

describe('verifyVerraReport', () => {
  it('returns true when a verified report exists in the period', async () => {
    const http = new MockHttpClient([{ status: 200, data: { reports: [REPORT] } }]);
    await expect(
      verifyVerraReport('VCS-1234', '2025-01-01', '2025-03-31', { baseUrl: BASE_URL, http }),
    ).resolves.toBe(true);
  });

  it('returns false when no verified report exists in the period', async () => {
    const http = new MockHttpClient([
      { status: 200, data: { reports: [{ ...REPORT, reporting_period_start: '2024-01-01' }] } },
    ]);
    await expect(
      verifyVerraReport('VCS-1234', '2025-01-01', '2025-03-31', { baseUrl: BASE_URL, http }),
    ).resolves.toBe(false);
  });
});
