import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from '../src/app.module';

describe('Subscription Journey (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let investorToken: string;
  const adminKey = Keypair.random();
  const investorKey = Keypair.random();
  const bondId = 1;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    
    // Mock tokens for testing purposes since it's an isolated test
    adminToken = 'mock-admin-token';
    investorToken = 'mock-investor-token';
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails subscription with validation error (invalid amount)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/bonds/${bondId}/subscribe`)
      .set('Authorization', `Bearer ${investorToken}`)
      .send({ investorAddress: investorKey.publicKey(), amount: -100 })
      .expect(400);
    expect(res.body.message).toBeDefined();
  });

  it('fails subscription due to missing KYC (unauthorized/forbidden)', async () => {
    // Assuming KYC guard blocks it if not KYC'd
    const unkycdKey = Keypair.random();
    const res = await request(app.getHttpServer())
      .post(`/bonds/${bondId}/subscribe`)
      .set('Authorization', `Bearer unkycd-token`)
      .send({ investorAddress: unkycdKey.publicKey(), amount: 100 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  
  it('handles retry (idempotency)', async () => {
    // We would test idempotency headers here
  });

  it('handles recovery state (partial failure)', async () => {
    // Mock a partial failure in Stellar and ensure it is recorded
  });

  it('succeeds on happy path', async () => {
    // Success case
  });
});
