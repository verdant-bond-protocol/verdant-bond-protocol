import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  HttpStatus,
  INestApplication,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Keypair } from '@stellar/stellar-sdk';
import * as request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { RequireIntent } from '../common/decorators/require-intent.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { IntentService } from '../common/services/intent.service';
import { RedisService } from '../common/services/redis.service';
import { IntentReceiptController } from './intent-receipt.controller';
import { IntentReceiptInterceptor } from './intent-receipt.interceptor';
import { IntentReceiptService, intentMessage } from './intent-receipt.service';
import { INTENT_RECEIPT_HEADER } from './intent-receipt.types';

/** Stand-in for a high-impact maintainer endpoint (e.g. coupon distribution). */
@Controller('bonds')
class FakeHighImpactController {
  calls = 0;

  @Post(':id/coupon')
  @UseGuards(JwtAuthGuard, IntentGuard)
  @RequireIntent('distribute_coupon')
  @HttpCode(HttpStatus.OK)
  distribute(@Param('id') id: string) {
    this.calls++;
    if (id === 'matured') throw new BadRequestException('Bond is matured');
    if (id === 'crash') throw new Error('rpc timeout talking to soroban-rpc.internal:8000');
    return { bondId: id, txHash: 'tx-' + id };
  }

  @Post('admin/reindex')
  @UseGuards(JwtAuthGuard, IntentGuard)
  @RequireIntent('reindex_holders', 'id', 'global')
  reindex() {
    return { queued: true };
  }
}

describe('Maintainer intent approval flow (HTTP)', () => {
  let app: INestApplication;
  let admin: Keypair;
  let receipts: IntentReceiptService;
  let controller: FakeHighImpactController;
  const usedNonces = new Set<string>();
  const env = { ...process.env };

  // JwtAuthGuard is replaced by a fake that authenticates the maintainer, so
  // IntentGuard sees req.user exactly as it does in production.
  const asAdmin: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      ctx.switchToHttp().getRequest().user = { walletAddress: admin.publicKey() };
      return true;
    },
  };

  function intent(action: string, target: string, nonce: string, signer = admin, expiryOffset = 60_000) {
    const base = { action, target, chain: 'testnet', expiry: Date.now() + expiryOffset, nonce };
    return JSON.stringify({ ...base, signature: signer.sign(Buffer.from(intentMessage(base), 'utf8')).toString('base64') });
  }

  beforeAll(async () => {
    admin = Keypair.random();
    process.env.STELLAR_PUBLIC_KEY = admin.publicKey();
    process.env.INTENT_RECEIPT_SIGNING_SECRET = Keypair.random().secret();

    const redis = {
      setNx: jest.fn(async (key: string) => {
        if (usedNonces.has(key)) return false;
        usedNonces.add(key);
        return true;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [FakeHighImpactController, IntentReceiptController],
      providers: [
        AuditService,
        IntentService,
        IntentGuard,
        IntentReceiptService,
        IntentReceiptInterceptor,
        { provide: RedisService, useValue: redis },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(asAdmin)
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    receipts = moduleRef.get(IntentReceiptService);
    controller = moduleRef.get(FakeHighImpactController);
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...env };
  });

  it('refuses the action without an explicit intent and records a rejected receipt', async () => {
    const before = controller.calls;
    const res = await request(app.getHttpServer()).post('/bonds/7/coupon').send({});
    expect(res.status).toBe(401);
    expect(controller.calls).toBe(before);

    const receiptId = res.headers[INTENT_RECEIPT_HEADER];
    expect(receiptId).toBeDefined();
    const receipt = await request(app.getHttpServer()).get(`/admin/intent-receipts/${receiptId}`);
    expect(receipt.body).toMatchObject({
      status: 'rejected',
      action: 'distribute_coupon',
      target: '7',
      actor: admin.publicKey(),
      rejectionReason: 'Admin intent required',
    });
  });

  it('runs the action with a valid intent and finalises a succeeded receipt before responding', async () => {
    const res = await request(app.getHttpServer())
      .post('/bonds/7/coupon')
      .set('x-admin-intent', intent('distribute_coupon', '7', 'ok-1'))
      .send({ amount: '100' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bondId: '7', txHash: 'tx-7' });

    const receiptId = res.headers[INTENT_RECEIPT_HEADER];
    const receipt = receipts.get(receiptId);
    expect(receipt.status).toBe('succeeded');
    expect(receipt.outcome?.httpStatus).toBe(200);
    expect(receipt.route).toBe('POST /bonds/:id/coupon');
    expect(receipt.nonce).toBe('ok-1');

    const verification = await request(app.getHttpServer()).get(`/admin/intent-receipts/${receiptId}/verify`);
    expect(verification.body).toMatchObject({ ok: true, receiptSignatureValid: true, intentSignatureValid: true, auditChainValid: true });
  });

  it('records a failed receipt with the client-facing message when the action throws an HttpException', async () => {
    const res = await request(app.getHttpServer())
      .post('/bonds/matured/coupon')
      .set('x-admin-intent', intent('distribute_coupon', 'matured', 'fail-1'));
    expect(res.status).toBe(400);
    const receipt = receipts.get(res.headers[INTENT_RECEIPT_HEADER]);
    expect(receipt.status).toBe('failed');
    expect(receipt.outcome).toMatchObject({ httpStatus: 400, errorMessage: 'Bond is matured' });
  });

  it('records a failed receipt without leaking internals when the action crashes', async () => {
    const res = await request(app.getHttpServer())
      .post('/bonds/crash/coupon')
      .set('x-admin-intent', intent('distribute_coupon', 'crash', 'crash-1'));
    expect(res.status).toBe(500);
    const receipt = receipts.get(res.headers[INTENT_RECEIPT_HEADER]);
    expect(receipt.status).toBe('failed');
    expect(JSON.stringify(receipt)).not.toContain('soroban-rpc.internal');
  });

  it('rejects a replayed nonce without running the action again', async () => {
    const header = intent('distribute_coupon', '9', 'replay-1');
    await request(app.getHttpServer()).post('/bonds/9/coupon').set('x-admin-intent', header).expect(200);
    const calls = controller.calls;
    const replay = await request(app.getHttpServer()).post('/bonds/9/coupon').set('x-admin-intent', header);
    expect(replay.status).toBe(409);
    expect(controller.calls).toBe(calls);
    expect(receipts.get(replay.headers[INTENT_RECEIPT_HEADER])).toMatchObject({ status: 'rejected', nonce: 'replay-1' });
  });

  it('rejects an intent signed for a different target', async () => {
    const res = await request(app.getHttpServer())
      .post('/bonds/10/coupon')
      .set('x-admin-intent', intent('distribute_coupon', '11', 'target-1'));
    expect(res.status).toBe(401);
    expect(receipts.get(res.headers[INTENT_RECEIPT_HEADER])).toMatchObject({ status: 'rejected', target: '10' });
  });

  it('rejects an intent signed by a non-admin key', async () => {
    const res = await request(app.getHttpServer())
      .post('/bonds/12/coupon')
      .set('x-admin-intent', intent('distribute_coupon', '12', 'forged-1', Keypair.random()));
    expect(res.status).toBe(401);
    expect(receipts.get(res.headers[INTENT_RECEIPT_HEADER]).status).toBe('rejected');
  });

  it('uses the default POST status for routes without @HttpCode and supports fixed targets', async () => {
    const res = await request(app.getHttpServer())
      .post('/bonds/admin/reindex')
      .set('x-admin-intent', intent('reindex_holders', 'global', 'reindex-1'));
    expect(res.status).toBe(201);
    expect(receipts.get(res.headers[INTENT_RECEIPT_HEADER])).toMatchObject({
      status: 'succeeded',
      target: 'global',
      outcome: { httpStatus: 201 },
    });
  });

  it('lets a maintainer list, review and re-verify receipts after the fact', async () => {
    const failed = await request(app.getHttpServer())
      .get('/admin/intent-receipts')
      .query({ status: 'failed', action: 'distribute_coupon' });
    expect(failed.status).toBe(200);
    expect(failed.body.length).toBeGreaterThanOrEqual(2);
    const target = failed.body[0];

    const reviewed = await request(app.getHttpServer())
      .post(`/admin/intent-receipts/${target.receiptId}/reviews`)
      .send({ disposition: 'confirmed', note: 'expected failure; coupon retried under new intent' });
    expect(reviewed.status).toBe(201);
    expect(reviewed.body.reviews[0]).toMatchObject({ reviewer: admin.publicKey(), disposition: 'confirmed' });

    const exported = (await request(app.getHttpServer()).get(`/admin/intent-receipts/${target.receiptId}`)).body;
    const ok = await request(app.getHttpServer()).post('/admin/intent-receipts/verify').send(exported);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const tampered = await request(app.getHttpServer())
      .post('/admin/intent-receipts/verify')
      .send({ ...exported, status: 'succeeded' });
    expect(tampered.body.ok).toBe(false);
  });

  it('validates query and review input', async () => {
    await request(app.getHttpServer()).get('/admin/intent-receipts').query({ status: 'bogus' }).expect(400);
    await request(app.getHttpServer()).get('/admin/intent-receipts/does-not-exist').expect(404);
    const [any] = receipts.list({ status: 'succeeded' });
    await request(app.getHttpServer())
      .post(`/admin/intent-receipts/${any.receiptId}/reviews`)
      .send({ disposition: 'confirmed' })
      .expect(400);
  });

  it('exposes the receipt signing key and stats', async () => {
    const key = await request(app.getHttpServer()).get('/admin/intent-receipts/signing-key');
    expect(key.body).toEqual({ algorithm: 'ed25519', publicKey: receipts.getSigner().publicKey, ephemeral: false });
    const stats = await request(app.getHttpServer()).get('/admin/intent-receipts/stats');
    expect(stats.body.byStatus.rejected).toBeGreaterThanOrEqual(4);
    expect(stats.body.byStatus.succeeded).toBeGreaterThanOrEqual(3);
  });
});

describe('@RequireIntent', () => {
  it('always attaches the receipt interceptor so intent-protected routes cannot skip receipts', () => {
    class Probe {
      @RequireIntent('mature_bond')
      handler() {}
    }
    const interceptors = Reflect.getMetadata('__interceptors__', Probe.prototype.handler) ?? [];
    expect(interceptors).toContain(IntentReceiptInterceptor);
  });
});
