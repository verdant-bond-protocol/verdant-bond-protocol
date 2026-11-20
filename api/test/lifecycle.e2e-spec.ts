import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/common/services/redis.service';
import { ContractService } from '../src/stellar/contract.service';
import { ConfigService } from '../src/config/config.service';
import { toBigIntString } from '../src/common/utils';
import { StableErrorCode } from '../src/stellar/contract-errors';
import * as crypto from 'crypto';

jest.setTimeout(400000); // 400 seconds timeout for full E2E lifecycle on Testnet

describe('Protocol Lifecycle (e2e)', () => {
  let app: INestApplication;
  let redisService: RedisService;
  let configService: ConfigService;

  let adminKey: Keypair;
  let userKey: Keypair;
  let investorKey: Keypair;
  let providerKey: Keypair;

  let adminToken: string;
  let userToken: string;
  let investorToken: string;

  let projectId: number;
  let bondId: number;
  let reportId: number;
  let orderId: number;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    redisService = moduleRef.get<RedisService>(RedisService);
    configService = moduleRef.get<ConfigService>(ConfigService);

    // Initialize keypairs from env
    adminKey = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY!);
    userKey = Keypair.fromSecret(process.env.USER_SECRET_KEY!);
    investorKey = Keypair.fromSecret(process.env.INVESTOR_SECRET_KEY!);
    providerKey = Keypair.fromSecret(process.env.PROVIDER_SECRET_KEY!);

    // Authenticate and obtain tokens for each role
    adminToken = await getAuthToken(adminKey);
    userToken = await getAuthToken(userKey);
    investorToken = await getAuthToken(investorKey);
  });

  afterAll(async () => {
    await app.close();
  });

  async function getAuthToken(keypair: Keypair): Promise<string> {
    const address = keypair.publicKey();
    
    // 1. Get challenge
    const resChallenge = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ address })
      .expect(200);

    const challenge = resChallenge.body.challenge;

    // 2. Sign challenge
    const signedChallenge = keypair.sign(Buffer.from(challenge)).toString('hex');

    // 3. Verify signature
    const resVerify = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({
        address,
        originalChallenge: challenge,
        signedChallenge,
      })
      .expect(200);

    return resVerify.body.accessToken;
  }

  // --- Step 1: Project Lifecycle ---
  describe('Project Registration & Approval', () => {
    it('allows a developer to register a project', async () => {
      const res = await request(app.getHttpServer())
        .post('/projects')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Amazon Biodiversity Restoration',
          methodology: 'VERRA-VCS',
          country: 'BR',
          location: '-3.46, -62.21',
          totalAreaHa: 2000,
          carbonSequestrationEstimate: 95000,
          blueCarbon: false,
          biodiversityCorridor: true,
          description: 'Restoring Amazon canopy corridor'
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('Pending');
      expect(res.body.ownerAddress).toBe(userKey.publicKey());
      projectId = res.body.id;

      // Verify Redis cache was populated
      if (redisService.isHealthy()) {
        const cached = await redisService.get(`project:${projectId}`);
        expect(cached).toBeDefined();
        expect(JSON.parse(cached!).name).toBe('Amazon Biodiversity Restoration');
      }
    });

    it('allows the admin to approve the project', async () => {
      const res = await request(app.getHttpServer())
        .post(`/projects/${projectId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.status).toBe('Approved');

      // Verify Redis cache was invalidated/updated
      if (redisService.isHealthy()) {
        const cached = await redisService.get(`project:${projectId}`);
        expect(cached).toBeDefined();
        expect(JSON.parse(cached!).status).toBe('Approved');
      }
    });
  });

  // --- Step 2: Bond Issuance & Subscription ---
  describe('Bond Issuance & Subscription', () => {
    it('allows the admin to issue a tokenized bond tranche', async () => {
      // Find project details to get the metadataIpfsHash (which serves as projectId hex string)
      const resProject = await request(app.getHttpServer())
        .get(`/projects/${projectId}`)
        .expect(200);
      
      const ipfsHashHex = Buffer.from(resProject.body.metadataIpfsHash).toString('hex').padEnd(64, '0').substring(0, 64);

      const res = await request(app.getHttpServer())
        .post('/bonds')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          projectId: ipfsHashHex,
          faceValue: 10, // Small value for test
          couponSchedule: [Math.floor(Date.now() / 1000) + 120], // Matures shortly
          creditType: 'Carbon',
          maturityDate: Math.floor(Date.now() / 1000) + 240, // 4 mins
          totalSupply: 10000,
        })
        .expect(201);

      expect(res.body.bondId).toBeDefined();
      expect(res.body.status).toBe('Active');
      bondId = res.body.bondId;

      if (redisService.isHealthy()) {
        const cached = await redisService.get(`bond:${bondId}`);
        expect(cached).toBeDefined();
        expect(JSON.parse(cached!).status).toBe('Active');
      }
    });

    it('allows the investor to subscribe to the bond tranche', async () => {
      const res = await request(app.getHttpServer())
        .post(`/bonds/${bondId}/subscribe`)
        .set('Authorization', `Bearer ${investorToken}`)
        .send({
          investorAddress: investorKey.publicKey(),
          amount: 500,
        })
        .expect(200);

      expect(res.body.amount).toBe('500');

      // Check holder balances
      const resHolders = await request(app.getHttpServer())
        .get(`/bonds/${bondId}/holders`)
        .expect(200);

      const holder = resHolders.body.holders.find((h: any) => h.address === investorKey.publicKey());
      expect(holder).toBeDefined();
      expect(holder.balance).toBe('500');
    });
  });

  // --- Step 3: Oracle Monitoring & Coupons ---
  describe('Oracle Monitoring & Coupon Distribution', () => {
    it('allows whitelisted oracle provider to submit a report', async () => {
      const resProject = await request(app.getHttpServer())
        .get(`/projects/${projectId}`)
        .expect(200);
      
      const ipfsHashHex = Buffer.from(resProject.body.metadataIpfsHash).toString('hex').padEnd(64, '0').substring(0, 64);

      const res = await request(app.getHttpServer())
        .post('/oracle/reports')
        .set('x-provider-address', providerKey.publicKey())
        .send({
          projectId: ipfsHashHex,
          periodStart: Math.floor(Date.now() / 1000) - 3600,
          periodEnd: Math.floor(Date.now() / 1000),
          carbonSequestered: 25000,
          methodology: 'VERRA-VCS',
          providerSignature: Buffer.alloc(64).toString('hex'), // Mock signature for test
          ipfsEvidenceHash: Buffer.alloc(32).toString('hex'),
        })
        .expect(201);

      expect(res.body.reportId).toBeDefined();
      expect(res.body.status).toBe('Verified'); // Automatically verified if signature threshold is met/mocked
      reportId = res.body.reportId;
    });

    it('allows the admin to trigger coupon distribution and allows investor to claim', async () => {
      // 1. Distribute coupon
      const resDist = await request(app.getHttpServer())
        .post(`/bonds/${bondId}/coupon`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          periodIndex: 0,
          reportId,
        })
        .expect(200);

      expect(resDist.body.periodIndex).toBe(0);
      expect(resDist.body.holderCount).toBeGreaterThan(0);

      // 2. Claim credits
      const resClaim = await request(app.getHttpServer())
        .post(`/bonds/${bondId}/claim`)
        .set('Authorization', `Bearer ${investorToken}`)
        .send({
          investorAddress: investorKey.publicKey(),
        })
        .expect(200);

      expect(resClaim.body.credits).toBeDefined();
      expect(BigInt(resClaim.body.credits)).toBeGreaterThan(0n);
    });
  });

  // --- Step 4: Secondary Marketplace Swaps ---
  describe('Secondary Marketplace DEX Trading', () => {
    it('allows the investor to list bond tokens on the DEX', async () => {
      // Fund buyer on DEX router quote asset
      const resDeposit = await request(app.getHttpServer())
        .post('/marketplace/deposit')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          asset: 'USDC',
          amount: 2000,
        })
        .expect(200);

      expect(resDeposit.body.amount).toBe('2000');

      // List bond tokens for sale
      const resList = await request(app.getHttpServer())
        .post('/marketplace/list')
        .set('x-wallet-address', investorKey.publicKey())
        .send({
          bondId,
          amount: 100,
          pricePerToken: 5,
          expiry: Math.floor(Date.now() / 1000) + 3600,
        })
        .expect(201);

      expect(resList.body.orderId).toBeDefined();
      expect(resList.body.status).toBe('Open');
      orderId = resList.body.orderId;
    });

    it('allows another user to purchase the listed bond tokens', async () => {
      const resBuy = await request(app.getHttpServer())
        .post('/marketplace/buy')
        .set('x-wallet-address', userKey.publicKey())
        .send({
          orderId,
          amount: 100,
        })
        .expect(200);

      expect(resBuy.body.status).toBe('Filled');

      // Verify balances updated on-chain
      const resHolders = await request(app.getHttpServer())
        .get(`/bonds/${bondId}/holders`)
        .expect(200);

      const seller = resHolders.body.holders.find((h: any) => h.address === investorKey.publicKey());
      const buyer = resHolders.body.holders.find((h: any) => h.address === userKey.publicKey());

      expect(seller.balance).toBe('400'); // 500 - 100
      expect(buyer.balance).toBe('100');
    });
  });

  // --- Step 5: Data Export & Provenance ---
  describe('Auditor Exports & Verification', () => {
    it('allows an auditor to export the project audit bundle and verify its checksum', async () => {
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectId}/export`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.project).toBeDefined();
      expect(res.body.reports).toBeDefined();
      expect(res.body.generationMetadata.checksum).toBeDefined();

      // Recalculate checksum to prove integrity
      const { checksum, ...rest } = res.body;
      const sortedData = JSON.stringify(rest, Object.keys(rest).sort());
      const reCalc = crypto.createHash('sha256').update(sortedData).digest('hex');
      expect(checksum).toBe(reCalc);
    });

    it('allows an auditor to export the bond audit bundle and verify its checksum', async () => {
      const res = await request(app.getHttpServer())
        .get(`/bonds/${bondId}/export`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.bond).toBeDefined();
      expect(res.body.holders).toBeDefined();
      expect(res.body.couponDistributions).toBeDefined();
      expect(res.body.generationMetadata.checksum).toBeDefined();

      // Recalculate checksum to prove integrity
      const { checksum, ...rest } = res.body;
      const sortedData = JSON.stringify(rest, Object.keys(rest).sort());
      const reCalc = crypto.createHash('sha256').update(sortedData).digest('hex');
      expect(checksum).toBe(reCalc);
    });
  });
});
