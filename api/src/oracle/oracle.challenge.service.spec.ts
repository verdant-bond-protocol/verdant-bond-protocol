import { Test } from '@nestjs/testing';
import { scValToNative, Keypair } from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return { ...actual, scValToNative: jest.fn((x: any) => x) };
});

const PROVIDER = Keypair.random().publicKey();
const CHALLENGER = Keypair.random().publicKey();

import { OracleService } from './oracle.service';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { ReportStatus } from './interfaces/oracle.interface';

const PROJECT = 'a1b2'.padEnd(64, '0');

function reportScVal(id: number, provider: string, statusIndex: number): any[] {
  return [
    BigInt(id),
    provider,
    Buffer.alloc(32),
    BigInt(1700000000),
    BigInt(1700086400),
    BigInt(1200),
    'VM0003',
    Buffer.alloc(32),
    statusIndex,
    BigInt(1700001000),
    statusIndex === 1 ? BigInt(1700002000) : BigInt(0),
  ];
}

function challengeScVal(reportId: number, resolved: boolean, resolutionIndex: number): any {
  return {
    report_id: BigInt(reportId),
    challenger: CHALLENGER,
    counter_evidence_hash: Buffer.from('c0ffee'.padEnd(64, '0'), 'hex'),
    submitted_at: BigInt(1699990000),
    resolved,
    resolution: resolutionIndex,
  };
}

describe('OracleService challenge review (#oracle-challenge)', () => {
  let service: OracleService;
  let simulateCall: jest.Mock;

  beforeEach(async () => {
    simulateCall = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: ContractService, useValue: { simulateCall, invokeContractMethod: jest.fn() } },
        { provide: IpfsService, useValue: { uploadJson: jest.fn() } },
        { provide: StellarService, useValue: { getKeypairFromSecret: jest.fn() } },
        { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(0) } },
        { provide: RedisService, useValue: { get: jest.fn().mockResolvedValue(null), setEx: jest.fn(), del: jest.fn() } },
        { provide: SigningKeyProvider, useValue: { adminSecret: jest.fn().mockReturnValue('SADMIN') } },
        { provide: ConfigService, useValue: { getOracleConsumerAddress: () => 'CORACLE' } },
      ],
    }).compile();
    service = moduleRef.get(OracleService);
  });

  it('maps every report status (pending/challenged/verified/rejected)', async () => {
    const expectations: Array<[number, ReportStatus]> = [
      [0, ReportStatus.Pending],
      [1, ReportStatus.Verified],
      [2, ReportStatus.Challenged],
      [3, ReportStatus.Rejected],
    ];
    for (const [index, expected] of expectations) {
      simulateCall.mockResolvedValue(reportScVal(1, PROVIDER, index));
      const report = await service.getReport(1);
      expect(report.status).toBe(expected);
    }
  });

  it('returns the full challenge state for a report, including resolution', async () => {
    simulateCall.mockImplementation((opts: any) => {
      if (opts.method === 'get_report') return reportScVal(7, PROVIDER, 2); // Challenged
      if (opts.method === 'get_challenge_history') {
        return [challengeScVal(7, true, 3), challengeScVal(99, false, 0)];
      }
      return [];
    });

    const state = await service.getReportChallengeState(7);

    expect(state.status).toBe(ReportStatus.Challenged);
    expect(state.challenged).toBe(true);
    expect(state.challenges).toHaveLength(1);
    expect(state.challenges[0].reportId).toBe(7);
    expect(state.challenges[0].counterEvidenceHash).toBe('c0ffee'.padEnd(64, '0'));
    expect(state.challenges[0].challengerAddress).toBe(CHALLENGER);
    expect(state.challenges[0].resolved).toBe(true);
    expect(state.challenges[0].resolution).toBe(ReportStatus.Rejected);
  });

  it('lists only challenged reports for a project, with their challenge record', async () => {
    simulateCall.mockImplementation((opts: any) => {
      if (opts.method === 'get_project_reports') return [BigInt(1), BigInt(2)];
      if (opts.method === 'get_report') {
        // report 1 = Challenged, report 2 = Verified
        return opts.args[0].value().toString() === '1'
          ? reportScVal(1, PROVIDER, 2)
          : reportScVal(2, PROVIDER, 1);
      }
      if (opts.method === 'get_challenge_history') return [challengeScVal(1, false, 0)];
      return [];
    });

    const summaries = await service.getProjectChallengedReports(PROJECT);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].report.id).toBe(1);
    expect(summaries[0].challenge?.reportId).toBe(1);
  });

  describe('getCouponEligibility', () => {
    function projectWith(statusIndexes: number[]) {
      simulateCall.mockImplementation((opts: any) => {
        if (opts.method === 'get_project_reports') return statusIndexes.map((_, i) => BigInt(i + 1));
        if (opts.method === 'get_report') {
          const id = Number(opts.args[0].value());
          return reportScVal(id, PROVIDER, statusIndexes[id - 1]);
        }
        return [];
      });
    }

    it('is eligible when at least one report is verified and none are disputed', async () => {
      projectWith([1]);
      const eligibility = await service.getCouponEligibility(PROJECT);
      expect(eligibility.eligible).toBe(true);
      expect(eligibility.blockedByReportIds).toHaveLength(0);
    });

    it('is blocked when a report is challenged', async () => {
      projectWith([1, 2]);
      const eligibility = await service.getCouponEligibility(PROJECT);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.blockedByReportIds).toContain(2);
      expect(eligibility.reasons.join(' ')).toMatch(/challenged|rejected/i);
    });

    it('is blocked when a report is rejected', async () => {
      projectWith([3]);
      const eligibility = await service.getCouponEligibility(PROJECT);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.blockedByReportIds).toContain(1);
    });

    it('is not eligible when there are no verified reports', async () => {
      projectWith([0, 2]);
      const eligibility = await service.getCouponEligibility(PROJECT);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons.join(' ')).toMatch(/no verified/i);
    });

    it('blocks overlapping verified periods but allows adjacent periods', async () => {
      projectWith([1, 1]);
      const overlapping = await service.getCouponEligibility(PROJECT);
      expect(overlapping.eligible).toBe(false);
      expect(overlapping.blockedByReportIds).toEqual(expect.arrayContaining([1, 2]));

      simulateCall.mockImplementation((opts: any) => {
        if (opts.method === 'get_project_reports') return [1n, 2n];
        if (opts.method === 'get_report') {
          const id = Number(opts.args[0].value());
          const report = reportScVal(id, PROVIDER, 1);
          if (id === 2) {
            report[3] = BigInt(1700086400);
            report[4] = BigInt(1700172800);
          }
          return report;
        }
        return [];
      });
      const adjacent = await service.getCouponEligibility(PROJECT);
      expect(adjacent.eligible).toBe(true);
    });
  });
});
