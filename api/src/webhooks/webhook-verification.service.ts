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
  private readonly processedEvents = new Map<string, number>();
  private readonly DEFAULT_REPLAY_WINDOW = 5 * 60 * 1000; // 5 minutes

  /**
   * Verifies webhook signature and timestamp
   */
  verifyWebhook(
    event: WebhookEvent,
    config: WebhookVerificationConfig,
  ): { valid: boolean; error?: string } {
    // Check if event has already been processed (replay attack)
    if (this.isReplayedEvent(event.id)) {
      this.logger.warn(`Replay attack detected for event ${event.id}`);
      return { valid: false, error: 'Event already processed' };
    }

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

    // Mark event as processed
    this.markEventProcessed(event.id, event.timestamp);

    return { valid: true };
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
    const processedTimestamp = this.processedEvents.get(eventId);
    if (!processedTimestamp) {
      return false;
    }

    // Clean up old processed events
    const now = Date.now();
    if (now - processedTimestamp > this.DEFAULT_REPLAY_WINDOW * 2) {
      this.processedEvents.delete(eventId);
      return false;
    }

    return true;
  }

  /**
   * Marks event as processed to prevent replay
   */
  private markEventProcessed(eventId: string, timestamp: number): void {
    this.processedEvents.set(eventId, timestamp);

    // Cleanup old entries periodically
    if (this.processedEvents.size > 10000) {
      this.cleanupProcessedEvents();
    }
  }

  /**
   * Removes processed events older than the replay window
   */
  private cleanupProcessedEvents(): void {
    const now = Date.now();
    const cutoff = now - this.DEFAULT_REPLAY_WINDOW * 2;

    for (const [eventId, timestamp] of this.processedEvents.entries()) {
      if (timestamp < cutoff) {
        this.processedEvents.delete(eventId);
      }
    }

    this.logger.debug(
      `Cleaned up processed events, remaining: ${this.processedEvents.size}`,
    );
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

      if (!verification.valid) {
        return res.status(401).json({
          error: verification.error || 'Webhook verification failed',
        });
      }

      req.webhookEvent = event;
      next();
    };
  }
}
