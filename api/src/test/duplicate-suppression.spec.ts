/**
 * Duplicate suppression for notifications and webhooks (#410).
 *
 * Webhooks run through a real Express app with the verification middleware,
 * and every redelivery is built the way senders build retries (Stripe: same
 * event id, fresh timestamp and signature, for up to 3 days). Notification
 * suppression across a restart runs against a real, ephemeral PostgreSQL.
 */
import * as crypto from 'crypto';
import * as path from 'path';
import { spawn, ChildProcessByStdio } from 'child_process';
import { Readable } from 'stream';
import * as express from 'express';
import * as request from 'supertest';
import { WebhookVerificationConfig, WebhookVerificationService } from '../webhooks/webhook-verification.service';
import { NotificationsService } from '../notifications/notifications.service';

const HOUR = 60 * 60 * 1000;

describe('Duplicate suppression (#410)', () => {
  describe('webhooks', () => {
    const config: WebhookVerificationConfig = {
      secret: 'webhook-secret',
      replayWindowMs: 5 * 60 * 1000,
      signatureHeader: 'x-webhook-signature',
      timestampHeader: 'x-webhook-timestamp',
    };
    let service: WebhookVerificationService;
    let handled: string[];
    let handler: (body: { id: string }) => Promise<number>;
    let app: express.Express;

    /** One delivery attempt: fresh timestamp and signature, as a sender's retry. */
    const deliver = (body: Record<string, unknown>, sign = config.secret) => {
      const timestamp = Date.now();
      const signature = crypto
        .createHmac('sha256', sign)
        .update(`${body.id}.${timestamp}.${JSON.stringify(body)}`)
        .digest('hex');
      return request(app)
        .post('/webhooks')
        .set(config.signatureHeader, signature)
        .set(config.timestampHeader, String(timestamp))
        .send(body);
    };

    beforeEach(() => {
      service = new WebhookVerificationService();
      handled = [];
      handler = async () => 200;
      app = express();
      app.use(express.json());
      app.post('/webhooks', service.createVerificationMiddleware(config), async (req, res) => {
        handled.push(req.body.id);
        res.status(await handler(req.body)).json({ ok: true });
      });
    });

    afterEach(() => jest.restoreAllMocks());

    it('processes the first delivery and acknowledges a redelivery without running the handler again', async () => {
      await deliver({ id: 'evt-1', type: 'coupon.distributed' }).expect(200, { ok: true });
      const redelivery = await deliver({ id: 'evt-1', type: 'coupon.distributed' }).expect(200);

      expect(redelivery.body).toEqual({ received: true, duplicate: true });
      expect(handled).toEqual(['evt-1']);
    });

    it('keeps suppressing redeliveries long after the replay window (sender retries for days)', async () => {
      const start = Date.now();
      await deliver({ id: 'evt-2' }).expect(200);

      jest.spyOn(Date, 'now').mockReturnValue(start + 48 * HOUR);
      await deliver({ id: 'evt-2' }).expect(200, { received: true, duplicate: true });

      jest.spyOn(Date, 'now').mockReturnValue(start + 73 * HOUR); // past the 72h dedupe window
      await deliver({ id: 'evt-2' }).expect(200, { ok: true });
      expect(handled).toEqual(['evt-2', 'evt-2']);
    });

    it('honours a configured dedupe window', async () => {
      service = new WebhookVerificationService();
      const short = { ...config, dedupeWindowMs: HOUR };
      app = express();
      app.use(express.json());
      app.post('/webhooks', service.createVerificationMiddleware(short), (req, res) => {
        handled.push(req.body.id);
        res.json({ ok: true });
      });
      const start = Date.now();
      await deliver({ id: 'evt-3' }).expect(200);

      jest.spyOn(Date, 'now').mockReturnValue(start + 2 * HOUR);
      await deliver({ id: 'evt-3' }).expect(200, { ok: true });
      expect(handled).toEqual(['evt-3', 'evt-3']);
    });

    it('processes a redelivery after the first attempt failed (retry path)', async () => {
      handler = async () => 500;
      await deliver({ id: 'evt-4' }).expect(500);

      handler = async () => 200;
      await deliver({ id: 'evt-4' }).expect(200, { ok: true });
      await deliver({ id: 'evt-4' }).expect(200, { received: true, duplicate: true });
      expect(handled).toEqual(['evt-4', 'evt-4']);
    });

    it('answers 409 to a redelivery that arrives while the first is still being handled', async () => {
      let finish!: (status: number) => void;
      handler = () => new Promise<number>((resolve) => (finish = resolve));

      const first = deliver({ id: 'evt-5' }).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await deliver({ id: 'evt-5' }).expect(409);

      finish(200);
      await first;
      await deliver({ id: 'evt-5' }).expect(200, { received: true, duplicate: true });
      expect(handled).toEqual(['evt-5']);
    });

    it('never acknowledges a forged duplicate: a processed id with a bad signature is 401', async () => {
      await deliver({ id: 'evt-6' }).expect(200);

      await deliver({ id: 'evt-6' }, 'attacker-secret').expect(401);
      expect(handled).toEqual(['evt-6']);
    });

    it('rejects a redelivered id whose payload was altered', async () => {
      await deliver({ id: 'evt-7', amount: '10' }).expect(200);

      const timestamp = Date.now();
      const signedForOriginal = crypto
        .createHmac('sha256', config.secret)
        .update(`evt-7.${timestamp}.${JSON.stringify({ id: 'evt-7', amount: '10' })}`)
        .digest('hex');
      await request(app)
        .post('/webhooks')
        .set(config.signatureHeader, signedForOriginal)
        .set(config.timestampHeader, String(timestamp))
        .send({ id: 'evt-7', amount: '10000' })
        .expect(401);
    });

    it('keeps memory bounded by forgetting the oldest ids first', async () => {
      (service as any).MAX_REMEMBERED_EVENTS = 2;
      for (const id of ['a', 'b', 'c']) await deliver({ id }).expect(200);

      await deliver({ id: 'c' }).expect(200, { received: true, duplicate: true });
      await deliver({ id: 'a' }).expect(200, { ok: true }); // evicted, so processed again
    });
  });

  describe('notifications', () => {
    let service: NotificationsService;
    const event = { userId: 'GINVESTOR', type: 'BOND_ISSUED', message: 'Bond 7 issued', eventId: 'bond_7_issued' };

    beforeEach(() => {
      delete process.env.DATABASE_URL;
      service = new NotificationsService();
    });

    it('delivers once and suppresses every redelivery of the same event', async () => {
      expect(service.createNotification(event)).not.toBeNull();
      expect(service.createNotification(event)).toBeNull();
      expect(service.createNotification({ ...event, message: 'retried with new text' })).toBeNull();

      expect(service.getNotifications(event.userId)).toHaveLength(1);
      expect(await service.getDecisions(event.userId)).toHaveLength(1);
    });

    it('scopes suppression to the recipient: the same event id still reaches another user', () => {
      service.createNotification(event);
      expect(service.createNotification({ ...event, userId: 'GOTHER' })).not.toBeNull();
    });

    it('keeps a preference-suppressed decision final when the event is redelivered after opting back in', async () => {
      await service.setPreferences(event.userId, { bond_updates: false });
      expect(service.createNotification(event)).toBeNull();

      await service.setPreferences(event.userId, { bond_updates: true });
      expect(service.createNotification(event)).toBeNull();

      const decisions = await service.getDecisions(event.userId);
      expect(decisions).toEqual([expect.objectContaining({ eventId: event.eventId, delivered: false })]);
    });

    it('suppresses mandatory alerts on redelivery too', () => {
      const alert = { userId: 'admin', type: 'PARTIAL_FAILURE', message: 'x', eventId: 'pf_settlement_tx1' };
      expect(service.createNotification(alert)).not.toBeNull();
      expect(service.createNotification(alert)).toBeNull();
    });

    it('still suppresses in-process when the durable decision write fails', async () => {
      const logged = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      (service as any).pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };

      expect(service.createNotification(event)).not.toBeNull();
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.createNotification(event)).toBeNull();
      expect(logged).toHaveBeenCalled();
    });
  });

  describe('notifications across a restart (real PostgreSQL)', () => {
    const PORT = 57446;
    let server: ChildProcessByStdio<null, Readable, Readable>;

    jest.setTimeout(60_000);

    beforeAll(async () => {
      process.env.DATABASE_URL = await new Promise<string>((resolve, reject) => {
        server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'test-setup', 'embedded-postgres-server.mjs'), String(PORT)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        server.stdout.on('data', (chunk) => {
          out += chunk.toString();
          const ready = out.match(/PGREADY:(\S+)/);
          if (ready) resolve(ready[1]);
        });
        server.on('exit', (code) => code && reject(new Error(`embedded postgres exited (${code})`)));
      });
    });

    afterAll(async () => {
      delete process.env.DATABASE_URL;
      await new Promise((resolve) => {
        server.once('exit', resolve);
        server.kill('SIGTERM');
      });
    });

    async function boot(): Promise<NotificationsService> {
      const instance = new NotificationsService();
      await instance.onModuleInit();
      return instance;
    }

    async function decisionPersisted(instance: NotificationsService, userId: string, eventId: string): Promise<void> {
      for (let i = 0; i < 50; i++) {
        if ((await instance.getDecisions(userId)).some((d) => d.eventId === eventId)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('decision was never persisted');
    }

    it('suppresses a producer retry that arrives after the API restarted', async () => {
      const before = await boot();
      const retry = { userId: 'admin', type: 'RECOVERY_INTERRUPTED', message: 'x', eventId: 'recovery_op1_submit' };
      expect(before.createNotification(retry)).not.toBeNull();
      await decisionPersisted(before, retry.userId, retry.eventId);
      await before.onModuleDestroy();

      const after = await boot();
      expect(after.createNotification(retry)).toBeNull();
      expect(await after.getDecisions(retry.userId)).toHaveLength(1);
      await after.onModuleDestroy();
    });

    it('only restores decisions from the last 30 days', async () => {
      const seed = await boot();
      await (seed as any).pool.query(
        `INSERT INTO notification_decisions (user_id, event_id, type, category, delivered, mandatory, decided_at)
         VALUES ('GOLD', 'ancient', 'BOND_ISSUED', 'bond_updates', true, false, now() - interval '31 days')`,
      );
      await seed.onModuleDestroy();

      const restarted = await boot();
      expect(restarted.createNotification({ userId: 'GOLD', type: 'BOND_ISSUED', message: 'x', eventId: 'ancient' })).not.toBeNull();
      await restarted.onModuleDestroy();
    });
  });
});
