import { BadRequestException, Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { BondsService } from './bonds.service';

/**
 * Regulator export for holder, coupon, and redemption history (#445).
 *
 * Regulators and auditors need a self-contained, checksummed extract of a
 * bond's lifecycle rather than the raw on-chain snapshot returned by
 * `BondsService.exportBond`. This service normalises that snapshot into three
 * explicit, flat history tables and renders them as JSON or RFC 4180 CSV:
 *
 *   - holderHistory     : current holder register (address + balance snapshot).
 *   - couponHistory     : one row per distributed coupon period.
 *   - redemptionHistory : one row per credit-retirement (redemption) record.
 *
 * The extract carries `generationMetadata` (exporter, timestamp, section,
 * checksum) so a downloaded file can be tied back to the request that produced
 * it and tampering after export is detectable.
 *
 * Operational notes:
 *   - The holder table is a point-in-time register: the coupon-engine does not
 *     persist per-transfer holder history, so historical balances cannot be
 *     reconstructed from chain state alone. Re-running the export after a
 *     transfer yields the new register.
 *   - Exports are read-only and never mutate protocol state, so there is no
 *     rollback path to document: a bad export is discarded and regenerated.
 *   - `all` + `csv` concatenates the three tables into one multi-section
 *     document (each section prefixed by `## <name>`), which is convenient for
 *     a single-file regulator submission; use JSON for a structured bundle.
 */

export type RegulatorExportFormat = 'json' | 'csv';
export type RegulatorExportSection = 'all' | 'holders' | 'coupons' | 'redemptions';

export const REGULATOR_EXPORT_FORMATS: RegulatorExportFormat[] = ['json', 'csv'];
export const REGULATOR_EXPORT_SECTIONS: RegulatorExportSection[] = [
  'all',
  'holders',
  'coupons',
  'redemptions',
];

export interface HolderHistoryRow {
  address: string;
  balance: string;
}

export interface CouponHistoryRow {
  periodIndex: number;
  startTime: number;
  endTime: number;
  totalCreditsEarned: string;
  reportId: number;
  undistributed: string;
}

export interface RedemptionHistoryRow {
  id: number;
  holder: string;
  amount: string;
  creditType: string;
  retiredAt: number;
  certificateIpfsHash: string;
}

export interface RegulatorExport {
  bondId: number;
  generationMetadata: {
    timestamp: string;
    exporterAddress: string;
    section: RegulatorExportSection;
    version: string;
    checksum: string;
  };
  bond: Record<string, unknown>;
  lifecycleEvents: Array<Record<string, unknown>>;
  holderHistory: HolderHistoryRow[];
  couponHistory: CouponHistoryRow[];
  redemptionHistory: RedemptionHistoryRow[];
}

export interface RenderedRegulatorExport {
  contentType: string;
  filename: string;
  body: string;
}

export const REGULATOR_EXPORT_VERSION = '1.0.0';

/** Column order per section, used for deterministic CSV output. */
const SECTION_COLUMNS: Record<Exclude<RegulatorExportSection, 'all'>, string[]> = {
  holders: ['address', 'balance'],
  coupons: [
    'periodIndex',
    'startTime',
    'endTime',
    'totalCreditsEarned',
    'reportId',
    'undistributed',
  ],
  redemptions: ['id', 'holder', 'amount', 'creditType', 'retiredAt', 'certificateIpfsHash'],
};

/** Minimal shape of the `BondsService.exportBond` payload this service consumes. */
interface RawExportPayload {
  bond?: Record<string, unknown>;
  lifecycleEvents?: Array<Record<string, unknown>>;
  holders?: Array<{ address: string; balance: string }>;
  couponDistributions?: Array<Record<string, unknown>>;
  retirements?: Array<Record<string, unknown>>;
}

export function isRegulatorExportFormat(value: string): value is RegulatorExportFormat {
  return (REGULATOR_EXPORT_FORMATS as string[]).includes(value);
}

export function isRegulatorExportSection(value: string): value is RegulatorExportSection {
  return (REGULATOR_EXPORT_SECTIONS as string[]).includes(value);
}

/** Escape a single CSV field per RFC 4180. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Render a header + rows block as RFC 4180 CSV. */
export function renderCsvRows(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const header = columns.map(csvField).join(',');
  const body = rows.map((row) => columns.map((column) => csvField(row[column])).join(','));
  return [header, ...body].join('\r\n');
}

function checksum(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

@Injectable()
export class RegulatorExportService {
  private readonly logger = new Logger(RegulatorExportService.name);

  constructor(private readonly bondsService: BondsService) {}

  /**
   * Normalise the raw bond export into the three history tables and attach a
   * checksummed generation-metadata block.
   */
  buildExport(
    bondId: number,
    raw: RawExportPayload,
    auditorAddress: string,
    section: RegulatorExportSection = 'all',
  ): RegulatorExport {
    const holderHistory: HolderHistoryRow[] = (raw.holders ?? []).map((holder) => ({
      address: holder.address,
      balance: holder.balance,
    }));

    const couponHistory: CouponHistoryRow[] = (raw.couponDistributions ?? []).map(
      (period) => ({
        periodIndex: Number(period.periodIndex),
        startTime: Number(period.startTime),
        endTime: Number(period.endTime),
        totalCreditsEarned: String(period.totalCreditsEarned ?? '0'),
        reportId: Number(period.reportId ?? 0),
        undistributed: String(period.undistributed ?? '0'),
      }),
    );

    const redemptionHistory: RedemptionHistoryRow[] = (raw.retirements ?? []).map(
      (record) => ({
        id: Number(record.id),
        holder: String(record.holder ?? ''),
        amount: String(record.amount ?? '0'),
        creditType: String(record.creditType ?? ''),
        retiredAt: Number(record.retiredAt ?? 0),
        certificateIpfsHash: String(record.certificateIpfsHash ?? ''),
      }),
    );

    const exportPayload: RegulatorExport = {
      bondId,
      generationMetadata: {
        timestamp: new Date().toISOString(),
        exporterAddress: auditorAddress,
        section,
        version: REGULATOR_EXPORT_VERSION,
        checksum: '',
      },
      bond: raw.bond ?? {},
      lifecycleEvents: raw.lifecycleEvents ?? [],
      holderHistory,
      couponHistory,
      redemptionHistory,
    };

    exportPayload.generationMetadata.checksum = checksum({
      bond: exportPayload.bond,
      lifecycleEvents: exportPayload.lifecycleEvents,
      holderHistory,
      couponHistory,
      redemptionHistory,
    });

    return exportPayload;
  }

  /** Render a built export as JSON or CSV for the requested section. */
  render(
    payload: RegulatorExport,
    format: RegulatorExportFormat,
    section: RegulatorExportSection,
  ): RenderedRegulatorExport {
    const ext = format === 'csv' ? 'csv' : 'json';
    const filename = `bond-${payload.bondId}-${section}.${ext}`;

    if (format === 'json') {
      const body =
        section === 'all'
          ? payload
          : {
              bondId: payload.bondId,
              generationMetadata: { ...payload.generationMetadata, section },
              data:
                section === 'holders'
                  ? payload.holderHistory
                  : section === 'coupons'
                    ? payload.couponHistory
                    : payload.redemptionHistory,
            };
      return {
        contentType: 'application/json; charset=utf-8',
        filename,
        body: JSON.stringify(body, null, 2),
      };
    }

    const body =
      section === 'all'
        ? REGULATOR_EXPORT_SECTIONS.filter(
            (name): name is Exclude<RegulatorExportSection, 'all'> => name !== 'all',
          )
            .map((name) => {
              const rows = this.rowsFor(payload, name);
              return `## ${name}\r\n${renderCsvRows(SECTION_COLUMNS[name], rows)}`;
            })
            .join('\r\n\r\n')
        : renderCsvRows(SECTION_COLUMNS[section], this.rowsFor(payload, section));

    return {
      contentType: 'text/csv; charset=utf-8',
      filename,
      body,
    };
  }

  /**
   * Fetch a bond's raw export and render it for a regulator. Validates the
   * requested format/section and requires an authenticated exporter so the
   * audit trail names a real actor.
   */
  async export(
    bondId: number,
    auditorAddress: string,
    options: { format?: string; section?: string } = {},
  ): Promise<RenderedRegulatorExport> {
    if (!auditorAddress) {
      throw new ForbiddenException('An authenticated exporter is required');
    }
    const format = options.format ?? 'json';
    const section = options.section ?? 'all';
    if (!isRegulatorExportFormat(format)) {
      throw new BadRequestException(
        `Unsupported export format "${format}" (expected json or csv)`,
      );
    }
    if (!isRegulatorExportSection(section)) {
      throw new BadRequestException(
        `Unsupported export section "${section}" (expected ${REGULATOR_EXPORT_SECTIONS.join(', ')})`,
      );
    }

    const raw = (await this.bondsService.exportBond(bondId, auditorAddress)) as RawExportPayload;
    const payload = this.buildExport(bondId, raw, auditorAddress, section);
    this.logger.log(`Regulator export generated for bond ${bondId} (${format}/${section})`);
    return this.render(payload, format, section);
  }

  private rowsFor(
    payload: RegulatorExport,
    section: Exclude<RegulatorExportSection, 'all'>,
  ): Array<Record<string, unknown>> {
    switch (section) {
      case 'holders':
        return payload.holderHistory as unknown as Array<Record<string, unknown>>;
      case 'coupons':
        return payload.couponHistory as unknown as Array<Record<string, unknown>>;
      case 'redemptions':
        return payload.redemptionHistory as unknown as Array<Record<string, unknown>>;
    }
  }
}
