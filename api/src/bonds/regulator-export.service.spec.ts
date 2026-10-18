import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  RegulatorExportService,
  csvField,
  renderCsvRows,
  isRegulatorExportFormat,
  isRegulatorExportSection,
} from './regulator-export.service';

describe('RegulatorExportService (#445)', () => {
  const audit = 'GAUDITOR';

  const rawPayload = {
    bond: { id: 7, faceValue: '1000', creditType: 'Carbon' },
    lifecycleEvents: [{ event: 'ISSUED', timestamp: '2025-01-01T00:00:00.000Z' }],
    holders: [
      { address: 'GHOLDER1', balance: '100' },
      { address: 'GHOLDER2', balance: '250' },
    ],
    couponDistributions: [
      {
        periodIndex: 0,
        startTime: 100,
        endTime: 200,
        totalCreditsEarned: '50',
        reportId: 3,
        undistributed: '5',
      },
    ],
    retirements: [
      {
        id: 1,
        holder: 'GHOLDER1',
        amount: '20',
        creditType: 'Carbon',
        retiredAt: 1_700_000_000,
        certificateIpfsHash: 'abc123',
      },
    ],
  };

  function makeService(bondsService: any = {}): RegulatorExportService {
    return new RegulatorExportService(bondsService as any);
  }

  function exportRaw(bondId = 7, auditor = audit) {
    return makeService().buildExport(bondId, rawPayload as any, auditor);
  }

  it('normalises the raw snapshot into holder, coupon, and redemption history', () => {
    const result = exportRaw();
    expect(result.bondId).toBe(7);
    expect(result.holderHistory).toEqual([
      { address: 'GHOLDER1', balance: '100' },
      { address: 'GHOLDER2', balance: '250' },
    ]);
    expect(result.couponHistory).toEqual([
      {
        periodIndex: 0,
        startTime: 100,
        endTime: 200,
        totalCreditsEarned: '50',
        reportId: 3,
        undistributed: '5',
      },
    ]);
    expect(result.redemptionHistory).toEqual([
      {
        id: 1,
        holder: 'GHOLDER1',
        amount: '20',
        creditType: 'Carbon',
        retiredAt: 1_700_000_000,
        certificateIpfsHash: 'abc123',
      },
    ]);
  });

  it('computes a stable checksum over the history tables', () => {
    const a = exportRaw();
    const b = exportRaw();
    expect(a.generationMetadata.checksum).toHaveLength(64);
    expect(a.generationMetadata.checksum).toBe(b.generationMetadata.checksum);
    expect(a.generationMetadata.exporterAddress).toBe(audit);
    expect(a.generationMetadata.version).toBe('1.0.0');
  });

  it('changes the checksum when a history row changes', () => {
    const base = exportRaw();
    const changed = makeService().buildExport(
      7,
      { ...rawPayload, holders: [{ address: 'GHOLDER1', balance: '101' }] } as any,
      audit,
    );
    expect(changed.generationMetadata.checksum).not.toBe(base.generationMetadata.checksum);
  });

  it('handles an empty bond with no history', () => {
    const result = makeService().buildExport(9, {} as any, audit);
    expect(result.holderHistory).toEqual([]);
    expect(result.couponHistory).toEqual([]);
    expect(result.redemptionHistory).toEqual([]);
    expect(result.lifecycleEvents).toEqual([]);
  });

  describe('CSV rendering', () => {
    it('escapes commas, quotes, and newlines per RFC 4180', () => {
      expect(csvField('plain')).toBe('plain');
      expect(csvField('a,b')).toBe('"a,b"');
      expect(csvField('say "hi"')).toBe('"say ""hi"""');
      expect(csvField('line1\nline2')).toBe('"line1\nline2"');
      expect(csvField(null)).toBe('');
    });

    it('renders header + rows with CRLF separators', () => {
      const csv = renderCsvRows(['a', 'b'], [{ a: 1, b: 'x,y' }]);
      expect(csv).toBe('a,b\r\n1,"x,y"');
    });

    it('renders a single section', () => {
      const result = makeService().render(exportRaw(), 'csv', 'holders');
      expect(result.contentType).toBe('text/csv; charset=utf-8');
      expect(result.filename).toBe('bond-7-holders.csv');
      expect(result.body).toBe('address,balance\r\nGHOLDER1,100\r\nGHOLDER2,250');
    });

    it('renders all sections into one multi-section document', () => {
      const result = makeService().render(exportRaw(), 'csv', 'all');
      expect(result.body).toContain('## holders\r\naddress,balance');
      expect(result.body).toContain('## coupons\r\nperiodIndex,startTime');
      expect(result.body).toContain('## redemptions\r\nid,holder');
    });
  });

  describe('JSON rendering', () => {
    it('returns the full bundle for section=all', () => {
      const result = makeService().render(exportRaw(), 'json', 'all');
      const parsed = JSON.parse(result.body);
      expect(parsed.holderHistory).toHaveLength(2);
      expect(parsed.couponHistory).toHaveLength(1);
      expect(parsed.redemptionHistory).toHaveLength(1);
      expect(result.contentType).toBe('application/json; charset=utf-8');
      expect(result.filename).toBe('bond-7-all.json');
    });

    it('returns just the requested section otherwise', () => {
      const result = makeService().render(exportRaw(), 'json', 'redemptions');
      const parsed = JSON.parse(result.body);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].holder).toBe('GHOLDER1');
      expect(parsed.generationMetadata.section).toBe('redemptions');
    });
  });

  describe('export() orchestration', () => {
    it('fetches the raw export and renders JSON by default', async () => {
      const bondsService = { exportBond: jest.fn().mockResolvedValue(rawPayload) };
      const service = makeService(bondsService);
      const result = await service.export(7, audit);
      expect(bondsService.exportBond).toHaveBeenCalledWith(7, audit);
      expect(result.contentType).toBe('application/json; charset=utf-8');
    });

    it('passes the requested format and section through', async () => {
      const bondsService = { exportBond: jest.fn().mockResolvedValue(rawPayload) };
      const service = makeService(bondsService);
      const result = await service.export(7, audit, { format: 'csv', section: 'holders' });
      expect(result.contentType).toBe('text/csv; charset=utf-8');
      expect(result.body).toContain('address,balance');
    });

    it('rejects an unauthenticated export', async () => {
      const service = makeService({ exportBond: jest.fn() });
      await expect(service.export(7, '')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an unknown format', async () => {
      const service = makeService({ exportBond: jest.fn() });
      await expect(service.export(7, audit, { format: 'xlsx' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an unknown section', async () => {
      const service = makeService({ exportBond: jest.fn() });
      await expect(service.export(7, audit, { section: 'profits' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('exposes format/section validators', () => {
    expect(isRegulatorExportFormat('csv')).toBe(true);
    expect(isRegulatorExportFormat('pdf')).toBe(false);
    expect(isRegulatorExportSection('coupons')).toBe(true);
    expect(isRegulatorExportSection('bogus')).toBe(false);
  });
});
