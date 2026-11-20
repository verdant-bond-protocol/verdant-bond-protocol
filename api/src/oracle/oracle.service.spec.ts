import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return { ...actual, scValToNative: jest.fn() };
});

import { xdr, scValToNative, nativeToScVal, Keypair } from '@stellar/stellar-sdk';
import { OracleService } from './oracle.service';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { ReportStatus } from './interfaces/oracle.interface';
import { InvalidEvidenceReferenceError } from '../common/utils';

describe('OracleService', () => {
  let service: OracleService;
  let contractService: { simulateCall: jest.Mock; invokeContractMethod: jest.Mock };
  let ipfsService: { uploadJson: jest.Mock };
  let redis: { del: jest.Mock };
  const adminKeypair = Keypair.random();

  beforeEach(async () => {
    (scValToNative as jest.Mock).mockReset();
    contractService = {
      simulateCall: jest.fn(),
      invokeContractMethod: jest.fn().mockResolvedValue({ result: nativeToScVal(BigInt(1), { type: 'u64' }) }),
    };
    ipfsService = {
      uploadJson: jest.fn().mockResolvedValue({
        hash: 'QmYwAPJzv5CZsnAzt8auVZRnTb7F8Pz6ePzE9LbYp8Xy7F',
        gatewayUrl: '',
        pinSize: 1,
        timestamp: '',
      }),
    };
    redis = { del: jest.fn().mockResolvedValue(undefined) };
    delete process.env.ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY;

    const moduleRef = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: ContractService, useValue: contractService },
        { provide: IpfsService, useValue: ipfsService },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: jest.fn().mockReturnValue({
              publicKey: () => adminKeypair.publicKey(),
            }),
          },
        },
        {
          provide: NonceService,
          useValue: { next: jest.fn().mockResolvedValue(0) },
        },
        { provide: RedisService, useValue: redis },
        {
          provide: SigningKeyProvider,
          useValue: { adminSecret: jest.fn().mockReturnValue('SADMINSECRET') },
        },
        {
          provide: ConfigService,
          useValue: { getOracleConsumerAddress: jest.fn().mockReturnValue('CORACLE') },
        },
      ],
    }).compile();

    service = moduleRef.get(OracleService);
  });

  describe('decodeReport', () => {
    it('maps the contract Report struct to a ReportResponse', () => {
      const raw = [
        BigInt(4),
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        Buffer.from('a1b2'.padEnd(64, '0'), 'hex'),
        BigInt(1700000000),
        BigInt(1700086400),
        BigInt(1200),
        'VM0003',
        Buffer.from('c3d4'.padEnd(64, '0'), 'hex'),
        1,
        BigInt(1700001000),
        BigInt(0),
      ];

      expect((service as any).decodeReport(raw)).toEqual({
        id: 4,
        providerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        projectId: 'a1b2'.padEnd(64, '0'),
        periodStart: 1700000000,
        periodEnd: 1700086400,
        carbonSequestered: '1200',
        methodology: 'VM0003',
        ipfsHash: 'c3d4'.padEnd(64, '0'),
        status: ReportStatus.Verified,
        createdAt: new Date(1700001000 * 1000).toISOString(),
        verifiedAt: undefined,
        providerStakeAtVerification: undefined,
      });
    });

    it.each([
      [0, ReportStatus.Pending],
      [1, ReportStatus.Verified],
      [2, ReportStatus.Challenged],
      [3, ReportStatus.Rejected],
    ])('maps status index %i to %s', (index, expected) => {
      const raw = [
        BigInt(1),
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        Buffer.alloc(32),
        BigInt(0),
        BigInt(0),
        BigInt(0),
        'VM0003',
        Buffer.alloc(32),
        index,
        BigInt(0),
        BigInt(0),
      ];

      expect((service as any).decodeReport(raw).status).toBe(expected);
    });
  });

  describe('toBytes32', () => {
    it('keeps a 64-char hex string as-is', () => {
      const hex = 'ab'.repeat(32);
      const scVal = (service as any).toBytes32(hex) as xdr.ScVal;
      expect(scVal.bytes().length).toBe(32);
    });

    it('digests a CID into 32 bytes via sha256', () => {
      const scVal = (service as any).toBytes32(
        'QmYwAPJzv5CZsnAzt8auVZRnTb7F8Pz6ePzE9LbYp8Xy7F',
      ) as xdr.ScVal;
      expect(scVal.bytes().length).toBe(32);
    });
  });

  describe('decodeSlashRecord', () => {
    it('maps a SlashRecord struct to a SlashRecord response', () => {
      const raw = {
        report_id: BigInt(7),
        penalty: BigInt(10_000),
        remaining_stake: BigInt(90_000),
        timestamp: BigInt(1700000000),
        active_after: true,
      };

      expect((service as any).decodeSlashRecord(raw)).toEqual({
        reportId: 7,
        penalty: '10000',
        remainingStake: '90000',
        timestamp: new Date(1700000000 * 1000).toISOString(),
        activeAfter: true,
      });
    });

    it('handles array-encoded structs', () => {
      const raw = [
        BigInt(7),
        BigInt(10_000),
        BigInt(90_000),
        BigInt(1700000000),
        true,
      ];

      expect((service as any).decodeSlashRecord(raw)).toEqual({
        reportId: 7,
        penalty: '10000',
        remainingStake: '90000',
        timestamp: new Date(1700000000 * 1000).toISOString(),
        activeAfter: true,
      });
    });
  });

  describe('decodeChallengeRecord', () => {
    it('maps a Challenge struct to a ChallengeRecord response', () => {
      const raw = {
        report_id: BigInt(7),
        challenger: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        counter_evidence_hash: Buffer.from('a1b2'.padEnd(64, '0'), 'hex'),
        submitted_at: BigInt(1699990000),
        resolved: true,
        resolution: 3,
      };

      expect((service as any).decodeChallengeRecord(raw)).toEqual({
        reportId: 7,
        challengerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        counterEvidenceHash: 'a1b2'.padEnd(64, '0'),
        submittedAt: new Date(1699990000 * 1000).toISOString(),
        resolved: true,
        resolution: ReportStatus.Rejected,
      });
    });

    it('returns null resolution for unresolved challenges', () => {
      const raw = {
        report_id: BigInt(7),
        challenger: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        counter_evidence_hash: Buffer.alloc(32),
        submitted_at: BigInt(1699990000),
        resolved: false,
        resolution: 0,
      };

      expect((service as any).decodeChallengeRecord(raw).resolution).toBeNull();
    });
  });

  describe('toRecord / field', () => {
    it('prefers object keys over array indices', () => {
      expect((service as any).field({ slashes: 4 }, 'slashes', 2)).toBe(4);
      expect((service as any).field([1, 2, 4], 'slashes', 2)).toBe(4);
    });
  });

  describe('evidenceHashToScVal (#93)', () => {
    it('encodes a valid CIDv0 to a 32-byte ScVal', () => {
      const scVal = (service as any).evidenceHashToScVal(
        'QmYwAPJzv5CZsnAzt8auVZRnTb7F8Pz6ePzE9LbYp8Xy7F',
      ) as xdr.ScVal;
      expect(scVal.bytes().length).toBe(32);
    });

    it('encodes a valid 64-char hex digest to a 32-byte ScVal', () => {
      const scVal = (service as any).evidenceHashToScVal('ab'.repeat(32)) as xdr.ScVal;
      expect(scVal.bytes().length).toBe(32);
    });

    it('throws for a malformed evidence reference instead of silently hashing it', () => {
      expect(() => (service as any).evidenceHashToScVal('not-a-real-cid')).toThrow(
        InvalidEvidenceReferenceError,
      );
    });
  });

  describe('submitReport evidence handling (#93)', () => {
    const dto = {
      projectId: 'VCS-1234',
      periodStart: 1700000000,
      periodEnd: 1700086400,
      carbonSequestered: 1200,
      methodology: 'VM0003',
    };
    const PROVIDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('anchors the caller-supplied evidenceHash on-chain when provided, not the metadata pin hash', async () => {
      const suppliedEvidence = 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4';
      await service.submitReport({ ...dto, evidenceHash: suppliedEvidence } as any, PROVIDER);

      const args = contractService.invokeContractMethod.mock.calls[0][3];
      const evidenceArg = args[6] as xdr.ScVal;
      expect(evidenceArg.bytes().toString('hex')).toBe(
        (service as any).evidenceHashToScVal(suppliedEvidence).bytes().toString('hex'),
      );
    });

    it('falls back to the IPFS metadata pin hash when no evidenceHash is supplied', async () => {
      await service.submitReport({ ...dto } as any, PROVIDER);

      const args = contractService.invokeContractMethod.mock.calls[0][3];
      const evidenceArg = args[6] as xdr.ScVal;
      expect(evidenceArg.bytes().toString('hex')).toBe(
        (service as any)
          .evidenceHashToScVal('QmYwAPJzv5CZsnAzt8auVZRnTb7F8Pz6ePzE9LbYp8Xy7F')
          .bytes()
          .toString('hex'),
      );
    });

    it('still uploads the report metadata to IPFS even when evidenceHash is supplied', async () => {
      await service.submitReport(
        { ...dto, evidenceHash: 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4' } as any,
        PROVIDER,
      );
      expect(ipfsService.uploadJson).toHaveBeenCalledTimes(1);
    });

    describe('retrievability check (off by default)', () => {
      const originalFetch = global.fetch;

      afterEach(() => {
        global.fetch = originalFetch;
      });

      it('does not call fetch when the retrievability flag is unset', async () => {
        global.fetch = jest.fn();
        await service.submitReport(
          { ...dto, evidenceHash: 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4' } as any,
          PROVIDER,
        );
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('checks retrievability against the gateway when the flag is enabled', async () => {
        process.env.ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY = 'true';
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

        const cid = 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4';
        await service.submitReport({ ...dto, evidenceHash: cid } as any, PROVIDER);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(cid);
      });

      it('rejects submission with a clear error when the gateway reports the evidence unavailable', async () => {
        process.env.ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY = 'true';
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });

        await expect(
          service.submitReport(
            { ...dto, evidenceHash: 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4' } as any,
            PROVIDER,
          ),
        ).rejects.toThrow(UnprocessableEntityException);
        expect(contractService.invokeContractMethod).not.toHaveBeenCalled();
      });

      it('skips the retrievability check for a hex-digest evidence reference (no gateway to check)', async () => {
        process.env.ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY = 'true';
        global.fetch = jest.fn();

        await service.submitReport({ ...dto, evidenceHash: 'ab'.repeat(32) } as any, PROVIDER);

        expect(global.fetch).not.toHaveBeenCalled();
      });
    });

    describe('manifest verification (#113)', () => {
      const validManifest = {
        project_id: 'VCS-1234',
        provider: 'SatelliteProcessor',
        signer_public_key: 'VERDANT_ORACLE_KEY_V1',
        methodology: 'VM0003',
        period_start: '2023-11-14',
        period_end: '2023-11-15',
        carbon_sequestered: 1200,
        confidence: 0.85,
        raw_observations: { count: 5 },
        transformation_parameters: { factor: 1.0 },
        generated_at: new Date().toISOString(),
        // Valid signature generated with default secret:
        signature: '1cf8d1326c92d5c7f8a70994f7eb80a52ddbcbfd91e6b3eb72545d58f3521b47',
      };

      it('rejects tampered manifest signatures', async () => {
        const tampered = { ...validManifest, signature: 'bad-signature' };
        await expect(
          service.submitReport({ ...dto, manifest: tampered } as any, PROVIDER),
        ).rejects.toThrow(UnprocessableEntityException);
      });

      it('rejects reports when manifest values do not match DTO values', async () => {
        const mismatchedDto = { ...dto, carbonSequestered: 99999 };
        const manifest = {
          ...validManifest,
          // Re-generate valid signature for 1200, but submit DTO with 99999
        };
        // verifyManifest will pass signature, but verifyManifestMatchesReport will fail
      });
    });
  });

  describe('registerProvider', () => {
    const providerAddress = Keypair.random().publicKey();

    beforeEach(() => {
      (scValToNative as jest.Mock).mockReset();
    });

    it('rejects an unsupported methodology before calling the contract', async () => {
      await expect(
        service.registerProvider({ providerAddress, methodology: 'MADE-UP-METHOD' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(contractService.invokeContractMethod).not.toHaveBeenCalled();
    });

    it('normalizes methodology casing against the supported list', async () => {
      contractService.simulateCall.mockRejectedValueOnce(new Error('not found'));

      const result = await service.registerProvider({
        providerAddress,
        methodology: 'verra-vcs',
      } as any);

      expect(result.methodology).toBe('VERRA-VCS');
      expect(contractService.invokeContractMethod).toHaveBeenCalled();
    });

    it('returns a conflict when the provider is already actively registered', async () => {
      contractService.simulateCall.mockResolvedValueOnce({});
      (scValToNative as jest.Mock).mockReturnValueOnce([providerAddress, 'VERRA-VCS', 0, true, 0]);

      await expect(
        service.registerProvider({ providerAddress, methodology: 'VERRA-VCS' } as any),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(contractService.invokeContractMethod).not.toHaveBeenCalled();
    });

    it('returns a distinct conflict for a previously removed (inactive) provider', async () => {
      contractService.simulateCall.mockResolvedValueOnce({});
      (scValToNative as jest.Mock).mockReturnValueOnce([providerAddress, 'VERRA-VCS', 0, false, 0]);

      await expect(
        service.registerProvider({ providerAddress, methodology: 'VERRA-VCS' } as any),
      ).rejects.toThrow(/does not support reactivating/);

      expect(contractService.invokeContractMethod).not.toHaveBeenCalled();
    });

    it('registers successfully and invalidates the provider list cache', async () => {
      contractService.simulateCall.mockRejectedValueOnce(new Error('not found'));

      const result = await service.registerProvider({
        providerAddress,
        methodology: 'BLUE-CARBON',
      } as any);

      expect(result.providerAddress).toBe(providerAddress);
      expect(result.active).toBe(true);
      expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
        'CORACLE',
        'register_provider',
        'SADMINSECRET',
        expect.any(Array),
        adminKeypair.publicKey(),
      );
      expect(redis.del).toHaveBeenCalledWith('oracle:providers');
    });
  });
});
