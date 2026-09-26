/**
 * Tests for Webhook Verification Service
 * Closes #272
 */

import { WebhookVerificationService } from './webhook-verification.service';
import * as crypto from 'crypto';

describe('WebhookVerificationService', () => {
  let service: WebhookVerificationService;

  const testConfig = {
    secret: 'test-secret-key',
    replayWindowMs: 5 * 60 * 1000,
    signatureHeader: 'x-webhook-signature',
    timestampHeader: 'x-webhook-timestamp',
  };

  beforeEach(() => {
    service = new WebhookVerificationService();
  });

  function createSignature(
    eventId: string,
    timestamp: number,
    payload: any,
    secret: string,
  ): string {
    const signedPayload = `${eventId}.${timestamp}.${JSON.stringify(payload)}`;
    return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  }

  describe('verifyWebhook', () => {
    it('should accept valid webhook', () => {
      const timestamp = Date.now();
      const payload = { data: 'test' };
      const eventId = 'evt-123';
      const signature = createSignature(eventId, timestamp, payload, testConfig.secret);

      const event = {
        id: eventId,
        timestamp,
        payload,
        signature,
      };

      const result = service.verifyWebhook(event, testConfig);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject webhook with invalid signature', () => {
      const event = {
        id: 'evt-123',
        timestamp: Date.now(),
        payload: { data: 'test' },
        signature: 'invalid-signature',
      };

      const result = service.verifyWebhook(event, testConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should reject webhook with missing signature', () => {
      const event = {
        id: 'evt-123',
        timestamp: Date.now(),
        payload: { data: 'test' },
      };

      const result = service.verifyWebhook(event, testConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing signature');
    });

    it('should reject stale webhook (too old)', () => {
      const timestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const payload = { data: 'test' };
      const eventId = 'evt-123';
      const signature = createSignature(eventId, timestamp, payload, testConfig.secret);

      const event = {
        id: eventId,
        timestamp,
        payload,
        signature,
      };

      const result = service.verifyWebhook(event, testConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Event timestamp outside replay window');
    });

    it('should reject webhook from the future', () => {
      const timestamp = Date.now() + 10 * 60 * 1000; // 10 minutes in future
      const payload = { data: 'test' };
      const eventId = 'evt-123';
      const signature = createSignature(eventId, timestamp, payload, testConfig.secret);

      const event = {
        id: eventId,
        timestamp,
        payload,
        signature,
      };

      const result = service.verifyWebhook(event, testConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Event timestamp outside replay window');
    });

    it('should reject replayed webhook (duplicate event ID)', () => {
      const timestamp = Date.now();
      const payload = { data: 'test' };
      const eventId = 'evt-duplicate';
      const signature = createSignature(eventId, timestamp, payload, testConfig.secret);

      const event = {
        id: eventId,
        timestamp,
        payload,
        signature,
      };

      // First call should succeed
      const result1 = service.verifyWebhook(event, testConfig);
      expect(result1.valid).toBe(true);

      // Second call with same event ID should fail
      const result2 = service.verifyWebhook(event, testConfig);
      expect(result2.valid).toBe(false);
      expect(result2.error).toBe('Event already processed');
    });

    it('should handle different payloads with same signature differently', () => {
      const timestamp = Date.now();
      const payload1 = { data: 'test1' };
      const payload2 = { data: 'test2' };
      const eventId = 'evt-123';
      const signature1 = createSignature(eventId, timestamp, payload1, testConfig.secret);

      const event = {
        id: eventId,
        timestamp,
        payload: payload2,
        signature: signature1,
      };

      const result = service.verifyWebhook(event, testConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });
  });

  describe('validateEventStructure', () => {
    it('should accept valid event structure', () => {
      const event = {
        id: 'evt-123',
        timestamp: Date.now(),
        payload: { data: 'test' },
      };

      expect(service.validateEventStructure(event)).toBe(true);
    });

    it('should reject event without ID', () => {
      const event = {
        timestamp: Date.now(),
        payload: { data: 'test' },
      };

      expect(service.validateEventStructure(event)).toBe(false);
    });

    it('should reject event without timestamp', () => {
      const event = {
        id: 'evt-123',
        payload: { data: 'test' },
      };

      expect(service.validateEventStructure(event)).toBe(false);
    });

    it('should reject event without payload', () => {
      const event = {
        id: 'evt-123',
        timestamp: Date.now(),
      };

      expect(service.validateEventStructure(event)).toBe(false);
    });

    it('should reject null event', () => {
      expect(service.validateEventStructure(null)).toBe(false);
    });

    it('should reject non-object event', () => {
      expect(service.validateEventStructure('string')).toBe(false);
    });
  });
});
