/**
 * Webhook Verification Service
 * 
 * Implements signed webhook verification and replay-window enforcement
 * to prevent replay attacks and ensure webhook authenticity.
 * 
 * Closes #272
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

export interface WebhookVerificationConfig {
  secret: string;
  replayWindowMs: number; // Default: 5 minutes
  signatureHeader: string;
  timestampHeader: string;
  /**
   * How long a processed event id is remembered for duplicate suppression
   * (#410). Senders redeliver the same event id with a fresh timestamp for
   * days (Stripe: up to 3 days), so this must outlast the sender's retry
   * schedule, not just the replay window. Default: 72 hours.
   */
  dedupeWindowMs?: number;
}

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
  /** Authentic redelivery of an event already processed (#410). */
  duplicate?: boolean;
}

export interface WebhookEvent {
  id: string;
  timestamp: number;
  payload: any;
  signature?: string;
}

@Injectable()
export class WebhookVerificationService {
  private readonly logger = new Logger(WebhookVerificationService.name);
  /**
   * Event id -> the last instant (ms) at which that event's timestamp still
   * passes the replay-window check. An id must be remembered at least that
   * long, or a captured request could be replayed inside its own window (#382).
   */
  private readonly processedEvents = new Map<string, number>();
  /** Events whose handler is running; a redelivery now must not be acknowledged yet. */
  private readonly inFlightEvents = new Set<string>();
  private readonly DEFAULT_REPLAY_WINDOW = 5 * 60 * 1000; // 5 minutes
  private readonly DEFAULT_DEDUPE_WINDOW = 72 * 60 * 60 * 1000; // 72 hours
  /** Hard memory bound on remembered ids; beyond it the oldest is forgotten first. */
  private readonly MAX_REMEMBERED_EVENTS = 100_000;

  /**
   * Verifies webhook signature and timestamp
   */
  verifyWebhook(
    event: WebhookEvent,
    config: WebhookVerificationConfig,
  ): WebhookVerificationResult {
    // Authenticity is established before duplicate status, so only a
    // genuinely signed redelivery can be acknowledged as a duplicate (#410).
    // Check timestamp to prevent stale events
    const now = Date.now();
    const replayWindow = config.replayWindowMs || this.DEFAULT_REPLAY_WINDOW;
    
    if (Math.abs(now - event.timestamp) > replayWindow) {
      this.logger.warn(
        `Stale event detected: ${event.id}, age: ${now - event.timestamp}ms`,
      );
      return { valid: false, error: 'Event timestamp outside replay window' };
    }

    // Verify signature
    if (!event.signature) {
      return { valid: false, error: 'Missing signature' };
    }

    const expectedSignature = this.computeSignature(
      event.id,
      event.timestamp,
      event.payload,
      config.secret,
    );

    if (!this.secureCompare(event.signature, expectedSignature)) {
      this.logger.warn(`Invalid signature for event ${event.id}`);
      return { valid: false, error: 'Invalid signature' };
    }

    // Duplicate: an authentic redelivery or replay of a processed event
    if (this.isReplayedEvent(event.id)) {
      this.logger.warn(`Duplicate delivery suppressed for event ${event.id}`);
      return { valid: false, error: 'Event already processed', duplicate: true };
    }

    // Remember the id for whichever lasts longer: the replay window of this
    // timestamp, or the sender's redelivery horizon.
    const dedupeWindow = config.dedupeWindowMs ?? this.DEFAULT_DEDUPE_WINDOW;
    this.markEventProcessed(event.id, Math.max(event.timestamp + replayWindow, now + dedupeWindow));

    return { valid: true };
  }

  /**
   * Forget a processed event whose handling failed, so the sender's next
   * delivery of it is processed rather than suppressed (#410).
   */
  releaseEvent(eventId: string): void {
    this.processedEvents.delete(eventId);
  }

  /**
   * Computes HMAC signature for webhook payload
   */
  private computeSignature(
    eventId: string,
    timestamp: number,
    payload: any,
    secret: string,
  ): string {
    const signedPayload = `${eventId}.${timestamp}.${JSON.stringify(payload)}`;
    return crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
  }

  /**
   * Timing-safe string comparison to prevent timing attacks
   */
  private secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }

  /**
   * Checks if event has already been processed
   */
  private isReplayedEvent(eventId: string): boolean {
    const acceptableUntil = this.processedEvents.get(eventId);
    if (acceptableUntil === undefined) {
      return false;
    }

    // Past both the replay window and the dedupe window: forget it.
    if (Date.now() > acceptableUntil) {
      this.processedEvents.delete(eventId);
      return false;
    }

    return true;
  }

  /**
   * Marks event as processed to prevent replay
   */
  private markEventProcessed(eventId: string, acceptableUntil: number): void {
    this.processedEvents.set(eventId, acceptableUntil);

    // Entries are inserted in roughly expiry order (now + a constant window),
    // so expired ids are evicted from the front: amortized O(1) per event.
    const now = Date.now();
    for (const [oldestId, until] of this.processedEvents) {
      if (until >= now && this.processedEvents.size <= this.MAX_REMEMBERED_EVENTS) break;
      this.processedEvents.delete(oldestId);
    }
  }

  /**
   * Validates webhook event structure
   */
  validateEventStructure(
    event: any,
  ): event is WebhookEvent {
    if (!event || typeof event !== 'object') {
      return false;
    }

    if (!event.id || typeof event.id !== 'string') {
      return false;
    }

    if (!event.timestamp || typeof event.timestamp !== 'number') {
      return false;
    }

    if (!event.payload) {
      return false;
    }

    return true;
  }

  /**
   * Express middleware for webhook verification
   */
  createVerificationMiddleware(config: WebhookVerificationConfig) {
    return (req: any, res: any, next: any) => {
      const signature = req.headers[config.signatureHeader];
      const timestamp = parseInt(req.headers[config.timestampHeader], 10);

      const event: WebhookEvent = {
        id: req.body.id || `${timestamp}-${Math.random()}`,
        timestamp,
        payload: req.body,
        signature,
      };

      if (!this.validateEventStructure(event)) {
        return res.status(400).json({
          error: 'Invalid webhook event structure',
        });
      }

      const verification = this.verifyWebhook(event, config);

      // Duplicate suppression (#410): acknowledge a redelivery of a processed
      // event without running the handler again, so the sender stops
      // retrying. While the first delivery is still being handled, answer
      // 409 instead: that one may yet fail and need this redelivery.
      if (verification.duplicate) {
        if (this.inFlightEvents.has(event.id)) {
          return res.status(409).json({ error: 'Event is still being processed; retry later' });
        }
        return res.status(200).json({ received: true, duplicate: true });
      }

      if (!verification.valid) {
        return res.status(401).json({
          error: verification.error || 'Webhook verification failed',
        });
      }

      // A handler failure (5xx) or a dropped connection releases the id, so
      // the sender's retry is processed instead of being suppressed.
      this.inFlightEvents.add(event.id);
      let settled = false;
      const settle = (succeeded: boolean) => {
        if (settled) return;
        settled = true;
        this.inFlightEvents.delete(event.id);
        if (!succeeded) this.releaseEvent(event.id);
      };
      res.once('finish', () => settle(res.statusCode < 500));
      res.once('close', () => settle(res.writableFinished && res.statusCode < 500));

      req.webhookEvent = event;
      next();
    };
  }
}
