/**
 * Signed webhook replay-window enforcement (#530).
 */
import * as crypto from 'crypto';
import * as express from 'express';
import * as request from 'supertest';
import { WebhookVerificationConfig, WebhookVerificationService } from './webhook-verification.service';

const MINUTE = 60 * 1000;

const config: WebhookVerificationConfig = {
  secret: 'current-secret',
  replayWindowMs: 5 * MINUTE,
  signatureHeader: 'x-webhook-signature',
  timestampHeader: 'x-webhook-timestamp',
};

const sign = (id: string, timestamp: number, payload: unknown, secret = config.secret) =>
  crypto.createHmac('sha256', secret).update(`${id}.${timestamp}.${JSON.stringify(payload)}`).digest('hex');

const event = (id: string, timestamp: number, secret = config.secret) => {
  const payload = { id, type: 'coupon.distributed' };
  return { id, timestamp, payload, signature: sign(id, timestamp, payload, secret) };
};

describe('Webhook replay-window enforcement (#530)', () => {
  let service: WebhookVerificationService;
  const now = Date.parse('2026-11-19T12:00:00Z');

  beforeEach(() => {
    service = new WebhookVerificationService();
    jest.useFakeTimers({ now });
  });
  afterEach(() => jest.useRealTimers());

  describe('normal path', () => {
    it('accepts a delivery at both edges of the window', () => {
      expect(service.verifyWebhook(event('old-edge', now - config.replayWindowMs), config).valid).toBe(true);
      expect(service.verifyWebhook(event('future-edge', now + config.replayWindowMs), config).valid).toBe(true);
    });
  });

  describe('failure path', () => {
    it('rejects a delivery 1ms past either edge', () => {
      expect(service.verifyWebhook(event('too-old', now - config.replayWindowMs - 1), config)).toEqual({
        valid: false,
        error: 'Event timestamp outside replay window',
      });
      expect(service.verifyWebhook(event('too-new', now + config.replayWindowMs + 1), config).valid).toBe(false);
    });

    it('bounds future clock skew separately when configured', () => {
      const tight = { ...config, maxFutureSkewMs: 30 * 1000 };
      expect(service.verifyWebhook(event('skew-ok', now + 30 * 1000), tight).valid).toBe(true);
      expect(service.verifyWebhook(event('skew-bad', now + 31 * 1000), tight)).toEqual({
        valid: false,
        error: 'Event timestamp outside replay window',
      });
      // Past-side tolerance is still the full replay window.
      expect(service.verifyWebhook(event('past-ok', now - 4 * MINUTE), tight).valid).toBe(true);
    });

    it('rejects a NaN or non-integer timestamp instead of letting it pass the window check', () => {
      const nan = { ...event('nan', now), timestamp: NaN };
      const fractional = event('fraction', now + 0.5);
      expect(service.verifyWebhook(nan, config)).toEqual({ valid: false, error: 'Invalid timestamp' });
      expect(service.verifyWebhook(fractional, config)).toEqual({ valid: false, error: 'Invalid timestamp' });
    });

    it('rejects a non-string signature (repeated header)', () => {
      const e = event('array-sig', now);
      const result = service.verifyWebhook({ ...e, signature: [e.signature, e.signature] as any }, config);
      expect(result).toEqual({ valid: false, error: 'Missing signature' });
    });
  });

  describe('retry path', () => {
    it('suppresses a replay inside the window and rejects it once the window passes', () => {
      const delivery = event('evt-replay', now);
      expect(service.verifyWebhook(delivery, config).valid).toBe(true);

      jest.setSystemTime(now + 4 * MINUTE);
      expect(service.verifyWebhook(delivery, config)).toMatchObject({ duplicate: true });

      jest.setSystemTime(now + config.replayWindowMs + 1);
      expect(service.verifyWebhook(delivery, config).error).toBe('Event timestamp outside replay window');
    });

    it('lets a released event be redelivered', () => {
      const delivery = event('evt-retry', now);
      expect(service.verifyWebhook(delivery, config).valid).toBe(true);
      service.releaseEvent('evt-retry');
      expect(service.verifyWebhook(delivery, config).valid).toBe(true);
    });
  });

  describe('authorization path', () => {
    it('accepts the previous secret during rotation and nothing else', () => {
      const rotating = { ...config, previousSecrets: ['old-secret'] };
      expect(service.verifyWebhook(event('rot-new', now), rotating).valid).toBe(true);
      expect(service.verifyWebhook(event('rot-old', now, 'old-secret'), rotating).valid).toBe(true);
      expect(service.verifyWebhook(event('rot-bad', now, 'attacker'), rotating)).toEqual({
        valid: false,
        error: 'Invalid signature',
      });
      // Without the rotation entry the old secret is refused.
      expect(service.verifyWebhook(event('rot-old-2', now, 'old-secret'), config).valid).toBe(false);
    });

    it('does not remember an id from a forged delivery', () => {
      expect(service.verifyWebhook(event('evt-forged', now, 'attacker'), config).valid).toBe(false);
      expect(service.verifyWebhook(event('evt-forged', now), config).valid).toBe(true);
    });
  });

  describe('middleware header parsing', () => {
    let app: express.Express;
    let handled: string[];

    beforeEach(() => {
      jest.useRealTimers();
      handled = [];
      app = express();
      app.use(express.json());
      app.post('/webhooks', service.createVerificationMiddleware(config), (req, res) => {
        handled.push(req.body.id);
        res.json({ ok: true });
      });
    });

    const post = (body: Record<string, unknown>, timestampHeader: string, signature: string) =>
      request(app)
        .post('/webhooks')
        .set(config.signatureHeader, signature)
        .set(config.timestampHeader, timestampHeader)
        .send(body);

    it('rejects a timestamp header with trailing garbage', async () => {
      const ts = Date.now();
      const body = { id: 'evt-garbage' };
      await post(body, `${ts}abc`, sign('evt-garbage', ts, body)).expect(400);
      expect(handled).toEqual([]);
    });

    it('rejects a body without an event id instead of inventing one', async () => {
      const ts = Date.now();
      const body = { type: 'coupon.distributed' };
      await post(body, String(ts), sign('undefined', ts, body)).expect(400);
      expect(handled).toEqual([]);
    });

    it('accepts a well-formed signed delivery', async () => {
      const ts = Date.now();
      const body = { id: 'evt-ok' };
      await post(body, String(ts), sign('evt-ok', ts, body)).expect(200, { ok: true });
      expect(handled).toEqual(['evt-ok']);
    });
  });
});
